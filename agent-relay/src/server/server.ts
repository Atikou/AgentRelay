/**
 * 轻量测试台后端：用 Node 内置 http 暴露当前已实现的 Agent 能力，供网页测试。
 *
 * 启动：npm run serve  （默认 http://localhost:18787）
 * 仅依赖标准库，不引入 Web 框架。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../config/loadConfig.js";
import { createModelClient } from "../model/ModelFactory.js";
import { MetricsRegistry } from "../model/MetricsRegistry.js";
import { ModelRouter, type ClientPricing } from "../model/ModelRouter.js";
import type { ModelClient } from "../model/types.js";
import { BackgroundTaskManager, NotificationQueue } from "../background/index.js";
import { Planner } from "../agent/Planner.js";
import { DryRunExecutor, TaskRunner } from "../agent/TaskRunner.js";
import { ToolStepExecutor } from "../agent/ToolStepExecutor.js";
import { AgentLoop, type LoopChatFn } from "../agent/AgentLoop.js";
import { ALL_PERMISSIONS, CONFIRMATION_REQUIRED } from "../agent/permissions.js";
import { PlanSchema } from "../agent/types.js";
import { ContextManager } from "../context/index.js";
import type { MemoryScope, MemoryType } from "../context/index.js";
import { SubAgentCoordinator, getSubAgentRole, listSubAgentRoles } from "../subagent/index.js";
import type { SubAgentRoleId } from "../subagent/index.js";
import type { ToolPermission } from "../agent/permissions.js";
import { createDefaultRegistry } from "../tools/index.js";
import { TraceLogger } from "../trace/TraceLogger.js";
import { readRecentTraceEvents, readReplayTraceEvents } from "../trace/traceReader.js";
import { Scheduler, CreateTriggerInputSchema } from "../scheduler/index.js";
import { loadEnvFile } from "../util/env.js";

loadEnvFile();

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, "..", "..");
const publicDir = path.join(projectRoot, "public");
const repoRoot = path.resolve(projectRoot, "..");
const docsDir = path.join(repoRoot, "docs");
const docsAssetsDir = path.join(docsDir, "assets");

const PORT = Number(process.env.PORT ?? 18787);

const { profile, config, workspaceRoot } = loadConfig();

/** 按 name 缓存客户端实例。 */
const clientMap = new Map<string, ModelClient>();
const pricing = new Map<string, ClientPricing>();
for (const c of config.models.clients) {
  clientMap.set(c.name, createModelClient(c));
  if (c.pricePer1kInputUsd !== undefined || c.pricePer1kOutputUsd !== undefined) {
    pricing.set(c.name, { inputPer1k: c.pricePer1kInputUsd, outputPer1k: c.pricePer1kOutputUsd });
  }
}

const metrics = new MetricsRegistry();
const traceFile = path.join(projectRoot, "data", "traces", "trace.jsonl");
const trace = new TraceLogger(traceFile);
const notificationQueue = new NotificationQueue(
  path.join(projectRoot, "data", "notifications", "notifications.jsonl"),
);
const schedCfg = config.scheduler;
const scheduler = new Scheduler(
  path.join(projectRoot, "data", "scheduler", "triggers.jsonl"),
  notificationQueue,
  trace,
  {
    workspaceRoot,
    unattendedGoalPatterns: schedCfg?.unattendedGoalPatterns ?? [],
    gitPollIntervalMs: schedCfg?.gitPollIntervalMs ?? 5000,
    defaultCronMissPolicy: schedCfg?.cronMissPolicy ?? "skip",
  },
);
const backgroundTasks = new BackgroundTaskManager(
  workspaceRoot,
  notificationQueue,
  trace,
  (record) => scheduler.handleBackgroundCompleted(record),
);
scheduler.start();
if (schedCfg?.dailySummaryCron && schedCfg.dailySummaryGoal) {
  const hasDaily = scheduler.list().some((t) => t.name === "__daily_summary__");
  if (!hasDaily) {
    scheduler.register({
      name: "__daily_summary__",
      kind: "cron",
      goal: schedCfg.dailySummaryGoal,
      cron: schedCfg.dailySummaryCron,
      cronMissPolicy: schedCfg.cronMissPolicy ?? "skip",
    });
  }
}
const router = new ModelRouter([...clientMap.values()], {
  strategy: config.routing.strategy,
  fallback: config.routing.fallback,
  metrics,
  trace,
  pricing,
});

const planner = new Planner((request, opts) => router.chat(request, opts));
const registry = createDefaultRegistry(trace);
const subAgentCoordinator = new SubAgentCoordinator({
  chat: (req, opts) => router.chat(req, opts),
  registry,
  workspaceRoot,
  trace,
});
const contextManager = new ContextManager({
  dataDir: path.join(projectRoot, "data"),
  useLanceDb: true,
});

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return {};
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.join(publicDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: "禁止访问" });
    return;
  }

  try {
    const content = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }
}

/** 解析请求中的 clientName；`__default__` 或未传则走路由策略。 */
function resolveForceClient(clientName?: string): { forceClient?: string; error?: string } {
  if (!clientName || clientName === "__default__") return {};
  if (!clientMap.has(clientName)) {
    return { error: `未找到模型客户端：${clientName}` };
  }
  return { forceClient: clientName };
}

function makeChatFn(forceClient?: string): LoopChatFn {
  return (req, opts) =>
    router.chat(req, {
      sensitive: opts?.sensitive,
      ...(forceClient ? { forceClient } : {}),
    });
}

function getSubAgentCoordinatorFor(forceClient?: string): SubAgentCoordinator {
  if (!forceClient) return subAgentCoordinator;
  return new SubAgentCoordinator({
    chat: makeChatFn(forceClient),
    registry,
    workspaceRoot,
    trace,
  });
}

function getConfigPayload() {
  return {
    profile,
    workspaceRoot,
    routing: config.routing,
    defaultModel: config.models.default,
    clients: config.models.clients.map((c) => ({
      name: c.name,
      provider: c.provider,
      location: c.location,
      model: c.model,
    })),
    /** 已注册的 API 能力（供测试台探测后端是否为当前版本）。 */
    capabilities: {
      traceAudit: true,
      contextPersistence: true,
      subAgent: true,
      scheduler: true,
      traceReplay: true,
    },
  };
}

async function handleModelsCheck() {
  const entries = config.models.clients.map(async (c) => {
    const client = clientMap.get(c.name)!;
    const available = await client.isAvailable();
    return { name: c.name, provider: c.provider, location: c.location, model: c.model, available };
  });
  return Promise.all(entries);
}

async function handleChat(body: unknown) {
  const payload = (body ?? {}) as {
    clientName?: string;
    message?: string;
    system?: string;
    sensitive?: boolean;
    sessionId?: string;
    persist?: boolean;
  };
  const message = (payload.message ?? "").trim();
  if (!message) {
    return { status: 400, body: { error: "message 不能为空" } };
  }

  // 指定具体客户端则强制该客户端；否则走路由「自主选择」+ 失败降级。
  const forceClient =
    payload.clientName && payload.clientName !== "__default__" ? payload.clientName : undefined;

  if (forceClient && !clientMap.has(forceClient)) {
    return { status: 404, body: { error: `未找到模型客户端：${forceClient}` } };
  }

  const persist = payload.persist !== false;
  const sessionId = persist ? ensureContextSession(payload.sessionId, "网页对话") : undefined;
  if (persist && sessionId) {
    contextManager.saveUserMessage(sessionId, message);
  }

  const systemBase = payload.system?.trim() ?? "";
  const messages =
    persist && sessionId
      ? contextManager.buildChatMessages(
          await contextManager.restoreContextPackage(sessionId, message),
          systemBase,
          { phase: "pre_call", currentUser: message },
        )
      : [
          ...(systemBase ? [{ role: "system" as const, content: systemBase }] : []),
          { role: "user" as const, content: message },
        ];

  try {
    const response = await router.chat(
      { messages, temperature: 0.3 },
      { forceClient, sensitive: payload.sensitive },
    );
    if (persist && sessionId) {
      contextManager.saveAssistantMessage(sessionId, response.content);
    }
    const finalized =
      persist && sessionId ? await contextManager.finalizeTurn(sessionId, message) : undefined;
    return {
      status: 200,
      body: {
        routed: !forceClient,
        clientName: response.clientName,
        modelName: response.modelName,
        location: response.location,
        latencyMs: Math.round(response.latencyMs),
        usage: response.usage,
        content: response.content,
        toolCalls: response.toolCalls,
        sessionId,
        compressed: finalized?.compressed ? true : undefined,
        phase: finalized?.postCall.phase,
        contextPackage: finalized?.postCall.contextPackage,
        renderedPrompt: finalized?.postCall.renderedPrompt,
      },
    };
  } catch (error) {
    return { status: 502, body: { error: `调用失败：${String(error)}` } };
  }
}

function handleMetrics() {
  return { stats: metrics.snapshot(), recent: metrics.recentCalls().slice(0, 20) };
}

function handleTraceRecent(url: URL) {
  const raw = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(1, raw), 200) : 50;
  const events = readRecentTraceEvents(traceFile, { limit, redact: true });
  return { status: 200, body: { events, count: events.length, redacted: true } };
}

function handleTraceExport(url: URL) {
  const raw = Number(url.searchParams.get("limit") ?? 500);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(1, raw), 2000) : 500;
  const events = readRecentTraceEvents(traceFile, { limit, redact: true });
  return {
    status: 200,
    body: { exportedAt: new Date().toISOString(), count: events.length, redacted: true, events },
  };
}

function handleTraceReplay(url: URL) {
  const raw = Number(url.searchParams.get("limit") ?? 100);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(1, raw), 500) : 100;
  const events = readReplayTraceEvents(traceFile, { limit, redact: true });
  return { status: 200, body: { events, count: events.length, redacted: true, replay: true } };
}

function ensureContextSession(sessionId: string | undefined, title: string): string {
  if (sessionId && contextManager.getSession(sessionId)) return sessionId;
  return contextManager.createSession(title).id;
}

/** 计划模式：根据目标生成结构化计划（只读）。 */
async function handlePlan(body: unknown) {
  const payload = (body ?? {}) as { goal?: string; context?: string; clientName?: string };
  const goal = (payload.goal ?? "").trim();
  if (!goal) {
    return { status: 400, body: { error: "goal 不能为空" } };
  }
  const { forceClient, error } = resolveForceClient(payload.clientName);
  if (error) return { status: 404, body: { error } };
  try {
    const activePlanner = forceClient ? new Planner(makeChatFn(forceClient)) : planner;
    const plan = await activePlanner.generatePlan(goal, payload.context);
    return { status: 200, body: { plan } };
  } catch (error) {
    return { status: 502, body: { error: `生成计划失败：${String(error)}` } };
  }
}

/** 任务模式（dry-run）：按计划走一遍状态机，不产生副作用，演示控制流。 */
async function handleTaskDryRun(body: unknown) {
  const payload = (body ?? {}) as { plan?: unknown; autoConfirm?: boolean };
  const parsed = PlanSchema.safeParse(payload.plan);
  if (!parsed.success) {
    return { status: 400, body: { error: `计划格式不合法：${parsed.error.message}` } };
  }
  const runner = new TaskRunner(parsed.data, {
    executor: new DryRunExecutor(),
    autoConfirm: payload.autoConfirm ?? false,
    trace,
  });
  const plan = await runner.run();
  return { status: 200, body: { plan } };
}

/** 任务模式（真实执行）：用工具注册表执行绑定了 tool 的步骤。高风险步骤需 autoConfirm。 */
async function handleTaskRun(body: unknown) {
  const payload = (body ?? {}) as { plan?: unknown; autoConfirm?: boolean };
  const parsed = PlanSchema.safeParse(payload.plan);
  if (!parsed.success) {
    return { status: 400, body: { error: `计划格式不合法：${parsed.error.message}` } };
  }
  const runner = new TaskRunner(parsed.data, {
    executor: new ToolStepExecutor({ registry, workspaceRoot }),
    autoConfirm: payload.autoConfirm ?? false,
    trace,
  });
  const plan = await runner.run();
  return { status: 200, body: { plan } };
}

/** 基础 Agent 自主循环：模型按需调用工具，迭代直到给出最终答案。 */
async function handleAgent(body: unknown) {
  const payload = (body ?? {}) as {
    message?: string;
    system?: string;
    autoConfirm?: boolean;
    sensitive?: boolean;
    maxIterations?: number;
    sessionId?: string;
    persist?: boolean;
    clientName?: string;
  };
  const message = (payload.message ?? "").trim();
  if (!message) return { status: 400, body: { error: "message 不能为空" } };

  const { forceClient, error } = resolveForceClient(payload.clientName);
  if (error) return { status: 404, body: { error } };

  const persist = payload.persist !== false;
  const sessionId = persist ? ensureContextSession(payload.sessionId, "智能体会话") : undefined;
  const loop = new AgentLoop({
    chat: makeChatFn(forceClient),
    registry,
    workspaceRoot,
    autoConfirm: payload.autoConfirm ?? false,
    sensitive: payload.sensitive,
    maxIterations: payload.maxIterations,
    trace,
    notificationQueue,
    contextManager: persist ? contextManager : undefined,
    sessionId,
  });

  try {
    const result = await loop.run(message, payload.system);
    return { status: 200, body: result };
  } catch (error) {
    return { status: 502, body: { error: `Agent 循环失败：${String(error)}` } };
  }
}

/** 启动后台命令（spawn，不阻塞 HTTP）。 */
function handleBackgroundStart(body: unknown) {
  const payload = (body ?? {}) as { command?: string; cwd?: string };
  const command = (payload.command ?? "").trim();
  if (!command) return { status: 400, body: { error: "command 不能为空" } };
  try {
    const task = backgroundTasks.start(command, payload.cwd);
    return { status: 200, body: { task } };
  } catch (error) {
    return { status: 400, body: { error: String(error) } };
  }
}

function handleBackgroundList() {
  return { tasks: backgroundTasks.list() };
}

function handleBackgroundGet(id: string) {
  const task = backgroundTasks.get(id);
  if (!task) return { status: 404, body: { error: "任务不存在" } };
  return { status: 200, body: { task } };
}

function handleBackgroundCancel(id: string) {
  const task = backgroundTasks.cancel(id);
  if (!task) return { status: 404, body: { error: "任务不存在或已结束" } };
  return { status: 200, body: { task } };
}

function handleNotificationsList(pendingOnly: boolean) {
  const notifications = pendingOnly
    ? notificationQueue.listPending()
    : notificationQueue.listAll();
  return { notifications };
}

function handleNotificationsConsume() {
  const notifications = notificationQueue.drain();
  return { consumed: notifications };
}

function handleSchedulerList() {
  return { triggers: scheduler.list() };
}

function handleSchedulerCreate(body: unknown) {
  const parsed = CreateTriggerInputSchema.safeParse(body);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: parsed.error.issues.map((i) => i.message).join("; ") },
    };
  }
  try {
    const trigger = scheduler.register(parsed.data);
    return { status: 200, body: { trigger } };
  } catch (error) {
    return { status: 400, body: { error: String(error) } };
  }
}

function handleSchedulerPause(id: string) {
  const trigger = scheduler.pause(id);
  if (!trigger) return { status: 404, body: { error: "触发器不存在" } };
  return { status: 200, body: { trigger } };
}

function handleSchedulerResume(id: string) {
  const trigger = scheduler.resume(id);
  if (!trigger) return { status: 404, body: { error: "触发器不存在" } };
  return { status: 200, body: { trigger } };
}

function handleSchedulerCancel(id: string) {
  const trigger = scheduler.cancel(id);
  if (!trigger) return { status: 404, body: { error: "触发器不存在" } };
  return { status: 200, body: { trigger } };
}

function handleSubAgentRoles() {
  return { roles: listSubAgentRoles() };
}

async function handleSubAgentRun(body: unknown) {
  const payload = (body ?? {}) as {
    role?: SubAgentRoleId;
    task?: string;
    context?: string;
    parentTaskId?: string;
    grantedPermissions?: string[];
    maxIterations?: number;
    timeoutMs?: number;
    sensitive?: boolean;
    clientName?: string;
  };
  const task = (payload.task ?? "").trim();
  if (!payload.role) return { status: 400, body: { error: "role 不能为空" } };
  if (!task) return { status: 400, body: { error: "task 不能为空" } };

  const { forceClient, error } = resolveForceClient(payload.clientName);
  if (error) return { status: 404, body: { error } };

  try {
    const roleDef = getSubAgentRole(payload.role);
    const coord = getSubAgentCoordinatorFor(forceClient);
    const result = await coord.run({
      role: payload.role,
      task,
      context: payload.context,
      parentTaskId: payload.parentTaskId,
      grantedPermissions: payload.grantedPermissions as ToolPermission[] | undefined,
      maxIterations: payload.maxIterations ?? roleDef.defaultMaxIterations,
      timeoutMs: payload.timeoutMs ?? roleDef.defaultTimeoutMs,
      sensitive: payload.sensitive,
    });
    return { status: 200, body: { result } };
  } catch (error) {
    return { status: 400, body: { error: String(error) } };
  }
}

function handleContextSessionsList() {
  return { sessions: contextManager.listSessions() };
}

function handleContextSessionCreate(body: unknown) {
  const payload = (body ?? {}) as { title?: string; projectId?: string };
  const session = contextManager.createSession(payload.title, payload.projectId);
  return { status: 200, body: { session } };
}

function handleContextSessionGet(id: string) {
  const session = contextManager.getSession(id);
  if (!session) return { status: 404, body: { error: "会话不存在" } };
  const messages = contextManager.messages.listBySession(id);
  const summaries = contextManager.summaries.listBySession(id);
  return { status: 200, body: { session, messages, summaries } };
}

async function handleContextSessionRestore(
  id: string,
  query?: string,
  phase: "pre_call" | "post_call" = "pre_call",
) {
  const session = contextManager.getSession(id);
  if (!session) return { status: 404, body: { error: "会话不存在" } };
  const snapshot = await contextManager.buildContextSnapshot(id, {
    phase,
    userInput: query,
    currentUser: phase === "pre_call" ? query : undefined,
  });
  return { status: 200, body: { session, ...snapshot } };
}

async function handleContextSessionCompress(id: string) {
  const session = contextManager.getSession(id);
  if (!session) return { status: 404, body: { error: "会话不存在" } };
  const compressed = await contextManager.summaryManager.compressIfNeeded(id);
  contextManager.summaryManager.ensureSessionSummary(id);
  return { status: 200, body: { compressed, needsCompression: contextManager.summaryManager.needsCompression(id) } };
}

async function handleContextSearch(url: URL) {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return { status: 400, body: { error: "q 不能为空" } };
  const scope = url.searchParams.get("scope") as MemoryScope | null;
  const scopeId = url.searchParams.get("scopeId") ?? undefined;
  try {
    const hits = await contextManager.search(q, scope ?? undefined, scopeId);
    return { status: 200, body: { hits } };
  } catch (error) {
    return {
      status: 200,
      body: {
        hits: [],
        warning: `向量检索暂不可用，已降级为仅 FTS：${String(error)}`,
      },
    };
  }
}

function handleContextMemoriesList(url: URL) {
  const scope = url.searchParams.get("scope") as MemoryScope | null;
  const scopeId = url.searchParams.get("scopeId") ?? undefined;
  const memories = contextManager.listMemories(scope ?? undefined, scopeId);
  return { status: 200, body: { memories } };
}

function handleContextMemoryDeactivate(id: string, body: unknown) {
  const memory = contextManager.getMemory(id);
  if (!memory) return { status: 404, body: { error: "记忆不存在" } };
  const payload = (body ?? {}) as { reason?: string };
  const reason = payload.reason?.trim() || "manual";
  const ok = contextManager.deactivateMemory(id, reason);
  if (!ok) return { status: 404, body: { error: "记忆不存在或已停用" } };
  return { status: 200, body: { memoryId: id, deactivated: true, reason } };
}

function handleContextMemoryCreate(body: unknown) {
  const payload = (body ?? {}) as {
    scope?: MemoryScope;
    scopeId?: string;
    memoryType?: MemoryType;
    key?: string;
    value?: string;
    summary?: string;
    importance?: number;
  };
  if (!payload.scope) return { status: 400, body: { error: "scope 不能为空" } };
  if (!payload.memoryType) return { status: 400, body: { error: "memoryType 不能为空" } };
  if (!payload.value?.trim()) return { status: 400, body: { error: "value 不能为空" } };
  const memory = contextManager.upsertMemory({
    scope: payload.scope,
    scopeId: payload.scopeId,
    memoryType: payload.memoryType,
    key: payload.key,
    value: payload.value.trim(),
    summary: payload.summary,
    importance: payload.importance,
  });
  return { status: 200, body: { memory } };
}

async function handleSubAgentBatch(body: unknown) {
  const payload = (body ?? {}) as {
    roles?: SubAgentRoleId[];
    task?: string;
    context?: string;
    parentTaskId?: string;
    grantedPermissions?: string[];
    maxIterations?: number;
    timeoutMs?: number;
    sensitive?: boolean;
    clientName?: string;
  };
  const task = (payload.task ?? "").trim();
  if (!task) return { status: 400, body: { error: "task 不能为空" } };
  if (!payload.roles?.length) return { status: 400, body: { error: "roles 不能为空" } };

  const { forceClient, error } = resolveForceClient(payload.clientName);
  if (error) return { status: 404, body: { error } };

  try {
    const maxIterations =
      payload.maxIterations ??
      Math.max(...payload.roles.map((r) => getSubAgentRole(r).defaultMaxIterations));
    const timeoutMs =
      payload.timeoutMs ??
      Math.max(...payload.roles.map((r) => getSubAgentRole(r).defaultTimeoutMs));
    const coord = getSubAgentCoordinatorFor(forceClient);
    const batch = await coord.runBatch({
      roles: payload.roles,
      task,
      context: payload.context,
      parentTaskId: payload.parentTaskId,
      grantedPermissions: payload.grantedPermissions as ToolPermission[] | undefined,
      maxIterations,
      timeoutMs,
      sensitive: payload.sensitive,
    });
    return { status: 200, body: batch };
  } catch (error) {
    return { status: 400, body: { error: String(error) } };
  }
}

/** 列出已注册工具。 */
function handleToolsList() {
  return { workspaceRoot, tools: registry.list() };
}

/** 执行单个工具。副作用工具（write/shell/...）需 body.confirm=true，否则返回 needsConfirmation。 */
async function handleToolRun(body: unknown) {
  const payload = (body ?? {}) as { name?: string; input?: unknown; confirm?: boolean };
  const name = (payload.name ?? "").trim();
  if (!name) return { status: 400, body: { error: "name 不能为空" } };

  const tool = registry.get(name);
  if (!tool) return { status: 404, body: { error: `未知工具：${name}` } };

  if (CONFIRMATION_REQUIRED.includes(tool.permission) && !payload.confirm) {
    return {
      status: 200,
      body: { needsConfirmation: true, tool: name, permission: tool.permission },
    };
  }

  const result = await registry.run(name, payload.input ?? {}, {
    workspaceRoot,
    allowedPermissions: ALL_PERMISSIONS,
  });
  return { status: result.ok ? 200 : 400, body: result };
}

/** 扫描 docs/ 下的 markdown，生成文档列表（标题取首个一级标题）。 */
async function handleDocsList() {
  let files: string[] = [];
  try {
    files = await readdir(docsDir);
  } catch {
    return [];
  }
  const mdFiles = files
    .filter((f) => f.toLowerCase().endsWith(".md") && f.toLowerCase() !== "readme.md")
    .sort();

  return Promise.all(
    mdFiles.map(async (file) => {
      const slug = file.slice(0, -3);
      let title = slug;
      try {
        const content = await readFile(path.join(docsDir, file), "utf-8");
        const match = content.match(/^#\s+(.+)$/m);
        if (match?.[1]) title = match[1].trim();
      } catch {
        // 读取失败则用文件名作标题。
      }
      return { slug, title };
    }),
  );
}

async function handleDocContent(slug: string) {
  const safe = slug.replace(/[\\/]/g, "");
  const filePath = path.join(docsDir, `${safe}.md`);
  if (!filePath.startsWith(docsDir)) {
    return { status: 403, body: { error: "禁止访问" } };
  }
  try {
    const markdown = await readFile(filePath, "utf-8");
    return { status: 200, body: { slug: safe, markdown } };
  } catch {
    return { status: 404, body: { error: "文档不存在" } };
  }
}

async function serveDocsAsset(res: ServerResponse, pathname: string): Promise<void> {
  const rel = decodeURIComponent(pathname.replace(/^\/docs-assets\//, ""));
  const filePath = path.join(docsAssetsDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(docsAssetsDir)) {
    sendJson(res, 403, { error: "禁止访问" });
    return;
  }
  try {
    const content = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const { pathname } = url;
    const method = req.method ?? "GET";

    try {
      if (pathname === "/api/config" && method === "GET") {
        sendJson(res, 200, getConfigPayload());
        return;
      }
      if (pathname === "/api/models/check" && method === "GET") {
        sendJson(res, 200, await handleModelsCheck());
        return;
      }
      if (pathname === "/api/chat" && method === "POST") {
        const result = await handleChat(await readBody(req));
        sendJson(res, result.status, result.body);
        return;
      }
      if (pathname === "/api/metrics" && method === "GET") {
        sendJson(res, 200, handleMetrics());
        return;
      }
      if (pathname === "/api/trace/recent" && method === "GET") {
        const result = handleTraceRecent(url);
        sendJson(res, result.status, result.body);
        return;
      }
      if (pathname === "/api/trace/export" && method === "GET") {
        const result = handleTraceExport(url);
        sendJson(res, result.status, result.body);
        return;
      }
      if (pathname === "/api/trace/replay" && method === "GET") {
        const result = handleTraceReplay(url);
        sendJson(res, result.status, result.body);
        return;
      }
      if (pathname === "/api/plan" && method === "POST") {
        const result = await handlePlan(await readBody(req));
        sendJson(res, result.status, result.body);
        return;
      }
      if (pathname === "/api/task/dry-run" && method === "POST") {
        const result = await handleTaskDryRun(await readBody(req));
        sendJson(res, result.status, result.body);
        return;
      }
      if (pathname === "/api/task/run" && method === "POST") {
        const result = await handleTaskRun(await readBody(req));
        sendJson(res, result.status, result.body);
        return;
      }
      if (pathname === "/api/agent" && method === "POST") {
        const result = await handleAgent(await readBody(req));
        sendJson(res, result.status, result.body);
        return;
      }
      if (pathname === "/api/background" && method === "GET") {
        sendJson(res, 200, handleBackgroundList());
        return;
      }
      if (pathname === "/api/background/start" && method === "POST") {
        const result = handleBackgroundStart(await readBody(req));
        sendJson(res, result.status, result.body);
        return;
      }
      if (pathname === "/api/notifications" && method === "GET") {
        const pendingOnly = url.searchParams.get("pending") === "1";
        sendJson(res, 200, handleNotificationsList(pendingOnly));
        return;
      }
      if (pathname === "/api/notifications/consume" && method === "POST") {
        sendJson(res, 200, handleNotificationsConsume());
        return;
      }
      if (pathname === "/api/scheduler/triggers" && method === "GET") {
        sendJson(res, 200, handleSchedulerList());
        return;
      }
      if (pathname === "/api/scheduler/triggers" && method === "POST") {
        const result = handleSchedulerCreate(await readBody(req));
        sendJson(res, result.status, result.body);
        return;
      }
      if (pathname.startsWith("/api/scheduler/triggers/")) {
        const rest = decodeURIComponent(pathname.slice("/api/scheduler/triggers/".length));
        if (rest.endsWith("/pause") && method === "POST") {
          const id = rest.slice(0, -"/pause".length);
          const result = handleSchedulerPause(id);
          sendJson(res, result.status, result.body);
          return;
        }
        if (rest.endsWith("/resume") && method === "POST") {
          const id = rest.slice(0, -"/resume".length);
          const result = handleSchedulerResume(id);
          sendJson(res, result.status, result.body);
          return;
        }
        if (rest.endsWith("/cancel") && method === "POST") {
          const id = rest.slice(0, -"/cancel".length);
          const result = handleSchedulerCancel(id);
          sendJson(res, result.status, result.body);
          return;
        }
      }
      if (pathname.startsWith("/api/background/") && pathname !== "/api/background/start") {
        const id = decodeURIComponent(pathname.slice("/api/background/".length));
        if (method === "GET") {
          const result = handleBackgroundGet(id);
          sendJson(res, result.status, result.body);
          return;
        }
        if (method === "POST" && id.endsWith("/cancel")) {
          const taskId = decodeURIComponent(id.slice(0, -"/cancel".length));
          const result = handleBackgroundCancel(taskId);
          sendJson(res, result.status, result.body);
          return;
        }
      }
      if (pathname === "/api/subagent/roles" && method === "GET") {
        sendJson(res, 200, handleSubAgentRoles());
        return;
      }
      if (pathname === "/api/subagent/run" && method === "POST") {
        const result = await handleSubAgentRun(await readBody(req));
        sendJson(res, result.status, result.body);
        return;
      }
      if (pathname === "/api/subagent/batch" && method === "POST") {
        const result = await handleSubAgentBatch(await readBody(req));
        sendJson(res, result.status, result.body);
        return;
      }
      if (pathname === "/api/context/sessions" && method === "GET") {
        sendJson(res, 200, handleContextSessionsList());
        return;
      }
      if (pathname === "/api/context/sessions" && method === "POST") {
        const result = handleContextSessionCreate(await readBody(req));
        sendJson(res, result.status, result.body);
        return;
      }
      if (pathname === "/api/context/search" && method === "GET") {
        const result = await handleContextSearch(url);
        sendJson(res, result.status, result.body);
        return;
      }
      if (pathname === "/api/context/memories" && method === "GET") {
        sendJson(res, 200, handleContextMemoriesList(url));
        return;
      }
      if (pathname === "/api/context/memories" && method === "POST") {
        const result = handleContextMemoryCreate(await readBody(req));
        sendJson(res, result.status, result.body);
        return;
      }
      if (pathname.startsWith("/api/context/memories/")) {
        const rest = decodeURIComponent(pathname.slice("/api/context/memories/".length));
        if (rest.endsWith("/deactivate") && method === "POST") {
          const id = rest.slice(0, -"/deactivate".length);
          const result = handleContextMemoryDeactivate(id, await readBody(req));
          sendJson(res, result.status, result.body);
          return;
        }
      }
      if (pathname.startsWith("/api/context/sessions/")) {
        const rest = decodeURIComponent(pathname.slice("/api/context/sessions/".length));
        if (rest.endsWith("/restore") && method === "GET") {
          const id = rest.slice(0, -"/restore".length);
          const phase =
            url.searchParams.get("phase") === "post_call" ? "post_call" : "pre_call";
          const result = await handleContextSessionRestore(
            id,
            url.searchParams.get("q") ?? undefined,
            phase,
          );
          sendJson(res, result.status, result.body);
          return;
        }
        if (rest.endsWith("/compress") && method === "POST") {
          const id = rest.slice(0, -"/compress".length);
          const result = await handleContextSessionCompress(id);
          sendJson(res, result.status, result.body);
          return;
        }
        if (method === "GET" && rest) {
          const result = handleContextSessionGet(rest);
          sendJson(res, result.status, result.body);
          return;
        }
      }
      if (pathname === "/api/tools" && method === "GET") {
        sendJson(res, 200, handleToolsList());
        return;
      }
      if (pathname === "/api/tools/run" && method === "POST") {
        const result = await handleToolRun(await readBody(req));
        sendJson(res, result.status, result.body);
        return;
      }
      if (pathname === "/api/docs" && method === "GET") {
        sendJson(res, 200, await handleDocsList());
        return;
      }
      if (pathname === "/api/docs/content" && method === "GET") {
        const result = await handleDocContent(url.searchParams.get("slug") ?? "");
        sendJson(res, result.status, result.body);
        return;
      }
      if (pathname.startsWith("/api/")) {
        sendJson(res, 404, { error: "未知接口" });
        return;
      }
      if (pathname.startsWith("/docs-assets/") && method === "GET") {
        await serveDocsAsset(res, pathname);
        return;
      }
      if (pathname === "/docs" || pathname === "/docs/") {
        await serveStatic(res, "/docs.html");
        return;
      }
      if (pathname === "/api-docs" || pathname === "/api-docs/") {
        await serveStatic(res, "/api-docs.html");
        return;
      }
      await serveStatic(res, pathname);
    } catch (error) {
      sendJson(res, 500, { error: String(error) });
    }
  })();
});

server.listen(PORT, () => {
  console.log(`测试台已启动：http://localhost:${PORT}  (profile=${profile})`);
});

process.on("SIGINT", () => {
  scheduler.stop();
  void trace.close().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  scheduler.stop();
  void trace.close().finally(() => process.exit(0));
});
