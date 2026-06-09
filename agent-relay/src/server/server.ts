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
import { Planner } from "../agent/Planner.js";
import { DryRunExecutor, TaskRunner } from "../agent/TaskRunner.js";
import { ToolStepExecutor } from "../agent/ToolStepExecutor.js";
import { AgentLoop } from "../agent/AgentLoop.js";
import { ALL_PERMISSIONS, CONFIRMATION_REQUIRED } from "../agent/permissions.js";
import { PlanSchema } from "../agent/types.js";
import { createDefaultRegistry } from "../tools/index.js";
import { TraceLogger } from "../trace/TraceLogger.js";
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
const trace = new TraceLogger(path.join(projectRoot, "data", "traces", "trace.jsonl"));
const router = new ModelRouter([...clientMap.values()], {
  strategy: config.routing.strategy,
  fallback: config.routing.fallback,
  metrics,
  trace,
  pricing,
});

const planner = new Planner((request, opts) => router.chat(request, opts));
const registry = createDefaultRegistry(trace);

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
  };
  const message = (payload.message ?? "").trim();
  if (!message) {
    return { status: 400, body: { error: "message 不能为空" } };
  }

  const messages = [
    ...(payload.system && payload.system.trim()
      ? [{ role: "system" as const, content: payload.system.trim() }]
      : []),
    { role: "user" as const, content: message },
  ];

  // 指定具体客户端则强制该客户端；否则走路由「自主选择」+ 失败降级。
  const forceClient =
    payload.clientName && payload.clientName !== "__default__" ? payload.clientName : undefined;

  if (forceClient && !clientMap.has(forceClient)) {
    return { status: 404, body: { error: `未找到模型客户端：${forceClient}` } };
  }

  try {
    const response = await router.chat(
      { messages, temperature: 0.3 },
      { forceClient, sensitive: payload.sensitive },
    );
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
      },
    };
  } catch (error) {
    return { status: 502, body: { error: `调用失败：${String(error)}` } };
  }
}

function handleMetrics() {
  return { stats: metrics.snapshot(), recent: metrics.recentCalls().slice(0, 20) };
}

/** 计划模式：根据目标生成结构化计划（只读）。 */
async function handlePlan(body: unknown) {
  const payload = (body ?? {}) as { goal?: string; context?: string };
  const goal = (payload.goal ?? "").trim();
  if (!goal) {
    return { status: 400, body: { error: "goal 不能为空" } };
  }
  try {
    const plan = await planner.generatePlan(goal, payload.context);
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
  };
  const message = (payload.message ?? "").trim();
  if (!message) return { status: 400, body: { error: "message 不能为空" } };

  const loop = new AgentLoop({
    chat: (req, opts) => router.chat(req, opts),
    registry,
    workspaceRoot,
    autoConfirm: payload.autoConfirm ?? false,
    sensitive: payload.sensitive,
    maxIterations: payload.maxIterations,
    trace,
  });

  try {
    const result = await loop.run(message, payload.system);
    return { status: 200, body: result };
  } catch (error) {
    return { status: 502, body: { error: `Agent 循环失败：${String(error)}` } };
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
      await serveStatic(res, pathname);
    } catch (error) {
      sendJson(res, 500, { error: String(error) });
    }
  })();
});

server.listen(PORT, () => {
  console.log(`测试台已启动：http://localhost:${PORT}  (profile=${profile})`);
});
