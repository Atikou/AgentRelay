/**
 * Orchestrator / RunStore 自检。
 * 运行：npm run test:orchestrator
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ContextManager } from "../src/context/ContextManager.js";
import type { LoopChatFn } from "../src/agent/AgentLoop.js";
import type { AgentStreamEvent } from "../src/orchestrator/AgentStream.js";
import { Orchestrator } from "../src/orchestrator/Orchestrator.js";
import { AgentRunRegistry } from "../src/orchestrator/AgentRunRegistry.js";
import { RunStore } from "../src/orchestrator/RunStore.js";
import { RunStateStore } from "../src/orchestrator/RunStateStore.js";
import { ALL_PERMISSIONS } from "../src/core/permissions.js";
import { DryRunExecutor, TaskRunner } from "../src/agent/TaskRunner.js";
import { PlanSchema } from "../src/agent/types.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import { createTestPlanService } from "./planTestHelper.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

let sandbox = "";
let dataDir = "";
let ctx: ContextManager;
let runs: RunStore;
let runStateStore: RunStateStore;

function baseOrchestrator(
  registry: ReturnType<typeof createDefaultRegistry>,
  extra?: Record<string, unknown>,
) {
  const ps = createTestPlanService({ workspaceRoot: sandbox, db: ctx.db, registry });
  const agentRunRegistry = new AgentRunRegistry();
  const orchestrator = new Orchestrator({
    workspaceRoot: sandbox,
    modelRouter: {} as never,
    planner: {} as never,
    registry,
    contextManager: ctx,
    tasks: ctx.tasks,
    runs,
    runStateStore,
    notificationQueue: {} as never,
    makeChatFn: () => async () => {
      throw new Error("no chat in test");
    },
    planService: ps,
    projectAllowedPermissions: ALL_PERMISSIONS,
    agentRunRegistry,
    ...extra,
  });
  return { orchestrator, planService: ps, agentRunRegistry };
}

test("RunStore 创建与查询", async () => {
  const run = runs.create({ kind: "agent", status: "running", goal: "test" });
  const got = runs.get(run.id);
  assert.ok(got);
  assert.equal(got!.kind, "agent");
  assert.equal(got!.status, "running");
});

test("TaskStore 可写入任务", async () => {
  const task = ctx.tasks.create({ goal: "hello", status: "pending" });
  assert.equal(task.goal, "hello");
  const updated = ctx.tasks.update(task.id, { status: "done" });
  assert.equal(updated?.status, "done");
});

test("TaskStore 持久化步骤、依赖与尝试记录", async () => {
  const task = ctx.tasks.create({ goal: "persist-steps", status: "in_progress" });
  ctx.tasks.upsertSteps(task.id, [
    {
      stepId: "s1",
      position: 0,
      title: "read",
      status: "completed",
      requiredPermissions: ["read"],
      needsConfirmation: false,
    },
    {
      stepId: "s2",
      position: 1,
      title: "write",
      status: "pending",
      requiredPermissions: ["write"],
      needsConfirmation: true,
      dependsOn: ["s1"],
      tool: "write_file",
      toolInput: { path: "a.txt" },
    },
  ]);
  const steps = ctx.tasks.listSteps(task.id);
  assert.equal(steps.length, 2);
  assert.deepEqual(steps[1]!.dependsOn, ["s1"]);
  assert.equal(steps[1]!.toolInput?.path, "a.txt");

  const attempt = ctx.tasks.recordAttempt({
    taskId: task.id,
    stepId: "s2",
    runId: "run-1",
    status: "blocked",
    error: "need confirm",
    endedAt: new Date().toISOString(),
  });
  assert.equal(attempt.stepId, "s2");
  assert.equal(ctx.tasks.listAttempts(task.id)[0]!.status, "blocked");
});

test("RunStore correlation_json 独立于 resultJson", async () => {
  const run = runs.create({
    kind: "chat",
    status: "running",
    goal: "corr",
    correlation: { runId: "pending", requestId: "req-1" },
  });
  runs.update(run.id, { correlationJson: JSON.stringify({ runId: run.id, requestId: "req-1" }) });
  runs.update(run.id, { status: "completed", resultJson: JSON.stringify({ content: "ok" }) });
  const got = runs.get(run.id);
  assert.ok(got?.correlationJson?.includes(run.id));
  assert.ok(got?.resultJson?.includes("ok"));
});

test("ContextManager setActiveTask 绑定与释放", async () => {
  const session = ctx.createSession("task-bind");
  const task = ctx.tasks.create({ goal: "bind", sessionId: session.id, status: "in_progress" });
  ctx.setActiveTask(session.id, task.id);
  assert.equal(ctx.getSession(session.id)?.activeTaskId, task.id);
  ctx.setActiveTask(session.id, null);
  assert.equal(ctx.getSession(session.id)?.activeTaskId, undefined);
});

test("Orchestrator task/run 拒绝 body 中的 plan JSON", async () => {
  const registry = createDefaultRegistry({ dataDir });
  const { orchestrator } = baseOrchestrator(registry);
  const plan = PlanSchema.parse({
    goal: "x",
    steps: [{ id: "s1", title: "t", status: "pending" }],
  });
  const result = await orchestrator.runTask({ plan, autoConfirm: true }, false);
  assert.equal(result.status, 400);
  assert.equal((result.body as { code?: string }).code, "PLAN_BODY_NOT_EXECUTABLE");
  registry.close();
});

test("Orchestrator task dry-run 产生 runId 与 taskId", async () => {
  const registry = createDefaultRegistry({ dataDir });
  const { orchestrator } = baseOrchestrator(registry);

  const plan = PlanSchema.parse({
    goal: "dry",
    steps: [{ id: "s1", title: "step", description: "x", status: "pending" }],
  });
  const result = await orchestrator.runTask({ plan, autoConfirm: true }, true);
  assert.equal(result.status, 200);
  const body = result.body as { runId: string; taskId: string };
  assert.ok(body.runId);
  assert.ok(body.taskId);
  assert.ok(runs.get(body.runId));
  assert.equal(ctx.tasks.listSteps(body.taskId).length, 1);
  assert.equal(ctx.tasks.listAttempts(body.taskId)[0]!.runId, body.runId);
  registry.close();
});

test("Orchestrator runAgentStream 推送 run_start 与 done", async () => {
  const registry = createDefaultRegistry({ dataDir });
  const makeChat: LoopChatFn = async () => ({
    content: '{"action":"final","answer":"流式完成"}',
    toolCalls: [],
    clientName: "fake",
    modelName: "fake",
    location: "local",
    latencyMs: 1,
  });
  const { orchestrator } = baseOrchestrator(registry, {
    notificationQueue: { drain: () => [] } as never,
    makeChatFn: () => makeChat,
  });
  const events: AgentStreamEvent[] = [];
  await orchestrator.runAgentStream(
    { message: "流式探测", persist: false },
    (e) => events.push(e),
    makeChat,
  );
  assert.equal(events[0]?.type, "run_start");
  assert.ok(events[0] && "runId" in events[0]);
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  if (done?.type === "done") assert.match(done.answer, /流式完成/);
  registry.close();
});

test("Orchestrator runAgentStream 推送 model_turn 与 step", async () => {
  const registry = createDefaultRegistry({ dataDir });
  let chatCalls = 0;
  const makeChat: LoopChatFn = async () => {
    chatCalls += 1;
    if (chatCalls === 1) {
      return {
        content: '{"action":"tool","tool":"read_file","input":{"path":"package.json"},"thought":"查看依赖"}',
        toolCalls: [],
        clientName: "fake",
        modelName: "fake",
        location: "local",
        latencyMs: 2,
      };
    }
    return {
      content: '{"action":"final","answer":"读完 package.json"}',
      toolCalls: [],
      clientName: "fake",
      modelName: "fake",
      location: "local",
      latencyMs: 1,
    };
  };
  const { orchestrator } = baseOrchestrator(registry, {
    notificationQueue: { drain: () => [] } as never,
    makeChatFn: () => makeChat,
  });
  const events: AgentStreamEvent[] = [];
  await orchestrator.runAgentStream(
    { message: "读 package.json", persist: false, autoConfirm: true },
    (e) => events.push(e),
    makeChat,
  );
  assert.ok(events.some((e) => e.type === "model_turn"));
  const started = events.filter((e) => e.type === "model_turn" && e.turn.phase === "started");
  assert.ok(started.length >= 1);
  assert.ok(events.some((e) => e.type === "step" && e.step.tool === "read_file"));
  registry.close();
});

test("Orchestrator runChatStream 推送 token 与 done", async () => {
  const registry = createDefaultRegistry({ dataDir });
  const fakeClient = {
    name: "fake-stream",
    model: "fake",
    location: "local" as const,
    isAvailable: async () => true,
    chat: async (req: { onToken?: (d: string) => void }) => {
      req.onToken?.("你");
      req.onToken?.("好");
      return {
        content: "你好",
        toolCalls: [],
        clientName: "fake-stream",
        modelName: "fake",
        location: "local" as const,
        latencyMs: 1,
      };
    },
  };
  const modelRouter = {
    chat: async (req: { onToken?: (d: string) => void }) => fakeClient.chat(req),
  } as never;
  const { orchestrator } = baseOrchestrator(registry, {
    modelRouter,
    notificationQueue: { drain: () => [] } as never,
  });
  const events: import("../src/orchestrator/ChatStream.js").ChatStreamEvent[] = [];
  await orchestrator.runChatStream(
    { message: "hi", persist: false, streamTokens: true, clientName: "fake-stream" },
    (e) => events.push(e),
  );
  assert.equal(events[0]?.type, "run_start");
  assert.ok(events.some((e) => e.type === "token"));
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  if (done?.type === "done") assert.equal(done.content, "你好");
  registry.close();
});

test("Orchestrator cancelRun 终止流式 Agent", async () => {
  const registry = createDefaultRegistry({ dataDir });
  const makeChat: LoopChatFn = async (req) => {
    await new Promise<never>((_resolve, reject) => {
      const signal = req.signal;
      if (!signal) {
        reject(new Error("测试需要 abort signal"));
        return;
      }
      if (signal.aborted) {
        reject(signal.reason ?? new Error("运行已取消"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(signal.reason ?? new Error("运行已取消")),
        { once: true },
      );
    });
    return {
      content: '{"action":"final","answer":"不应到达"}',
      toolCalls: [],
      clientName: "fake",
      modelName: "fake",
      location: "local",
      latencyMs: 1,
    };
  };
  const { orchestrator } = baseOrchestrator(registry, {
    notificationQueue: { drain: () => [] } as never,
    makeChatFn: () => makeChat,
  });
  const events: AgentStreamEvent[] = [];
  const streamPromise = orchestrator.runAgentStream(
    { message: "取消探测", persist: false },
    (e) => events.push(e),
    makeChat,
  );
  for (let i = 0; i < 30; i++) {
    const running = orchestrator.listRunningAgentRuns();
    if (running.length > 0) {
      const cancel = orchestrator.cancelRun(running[0]!.runId);
      assert.equal(cancel.status, 200);
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  await streamPromise;
  const done = events.find((e) => e.type === "done");
  assert.ok(done);
  if (done?.type === "done") {
    assert.equal(done.executionMeta.stopReason, "user_cancelled");
    assert.match(done.answer, /已取消/);
  }
  registry.close();
});

test("Orchestrator cancelRun 对不存在 run 返回 404", async () => {
  const registry = createDefaultRegistry({ dataDir });
  const { orchestrator } = baseOrchestrator(registry);
  const result = orchestrator.cancelRun("missing-run-id");
  assert.equal(result.status, 404);
  registry.close();
});

test("Orchestrator cancelRun 终止流式 Chat", async () => {
  const registry = createDefaultRegistry({ dataDir });
  const fakeClient = {
    name: "fake-chat-cancel",
    model: "fake",
    location: "local" as const,
    isAvailable: async () => true,
    chat: async (req: { signal?: AbortSignal }) => {
      await new Promise<never>((_resolve, reject) => {
        const signal = req.signal;
        if (!signal) {
          reject(new Error("测试需要 abort signal"));
          return;
        }
        if (signal.aborted) {
          reject(signal.reason ?? new Error("运行已取消"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => reject(signal.reason ?? new Error("运行已取消")),
          { once: true },
        );
      });
      return {
        content: "不应到达",
        toolCalls: [],
        clientName: "fake-chat-cancel",
        modelName: "fake",
        location: "local" as const,
        latencyMs: 1,
      };
    },
  };
  const modelRouter = {
    chat: async (req: { signal?: AbortSignal }) => fakeClient.chat(req),
  } as never;
  const { orchestrator } = baseOrchestrator(registry, {
    modelRouter,
    notificationQueue: { drain: () => [] } as never,
  });
  const events: import("../src/orchestrator/ChatStream.js").ChatStreamEvent[] = [];
  const streamPromise = orchestrator.runChatStream(
    { message: "cancel chat", persist: false, clientName: "fake-chat-cancel" },
    (e) => events.push(e),
  );
  for (let i = 0; i < 30; i++) {
    const running = orchestrator.listRunningAgentRuns();
    if (running.length > 0) {
      orchestrator.cancelRun(running[0]!.runId);
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  await streamPromise;
  const done = events.find((e) => e.type === "done");
  assert.ok(done);
  if (done?.type === "done") {
    assert.equal(done.cancelled, true);
    assert.match(done.content, /已取消/);
  }
  registry.close();
});

test("Orchestrator runAgent 推断计划模式并返回 executionMeta", async () => {
  const registry = createDefaultRegistry({ dataDir });
  const makeChat: LoopChatFn = async () => ({
    content: '{"action":"final","answer":"只读计划完成"}',
    toolCalls: [],
    clientName: "fake",
    modelName: "fake",
    location: "local",
    latencyMs: 1,
  });
  const { orchestrator } = baseOrchestrator(registry, {
    notificationQueue: { drain: () => [] } as never,
    makeChatFn: () => makeChat,
  });
  const result = await orchestrator.runAgent(
    { message: "请进入计划模式，只读分析项目", persist: false },
    makeChat,
  );
  assert.equal(result.status, 200);
  const body = result.body as { executionMeta: { mode: string; budget: { maxModelTurns: number; maxWriteCalls: number } } };
  assert.equal(body.executionMeta.mode, "plan");
  assert.equal(body.executionMeta.budget.maxModelTurns, 16);
  assert.equal(body.executionMeta.budget.maxWriteCalls, 0);
  registry.close();
});

test("Orchestrator runAgent 拒绝非法 mode", async () => {
  const registry = createDefaultRegistry({ dataDir });
  const { orchestrator } = baseOrchestrator(registry, {
    notificationQueue: { drain: () => [] } as never,
    makeChatFn: () => async () => {
      throw new Error("no chat in validation test");
    },
  });
  const result = await orchestrator.runAgent({ message: "hello", mode: "invalid", persist: false });
  assert.equal(result.status, 400);
  assert.match(String((result.body as { error?: string }).error), /mode/);
  registry.close();
});

test("Orchestrator generatePlan 拒绝 Markdown 报告型提示", async () => {
  const registry = createDefaultRegistry({ dataDir });
  const { orchestrator } = baseOrchestrator(registry);
  const result = await orchestrator.generatePlan({
    goal: "# 计划模式分析结果\n\n## 1. 目标理解\n\n本次仅生成计划，未修改任何文件。",
  });
  assert.equal(result.status, 400);
  const body = result.body as { code?: string; suggestedEndpoint?: string };
  assert.equal(body.code, "PLAN_REPORT_REQUEST");
  assert.equal(body.suggestedEndpoint, "/api/agent");
  registry.close();
});


test("Orchestrator rollbackOnFailure 失败时逆序回滚写文件", async () => {
  const registry = createDefaultRegistry({ dataDir });
  const { orchestrator, planService } = baseOrchestrator(registry);

  const target = path.join(sandbox, "rollback-task.txt");
  await fs.writeFile(target, "original", "utf-8");

  const plan = PlanSchema.parse({
    goal: "rollback on failure",
    steps: [
      {
        id: "s1",
        title: "write",
        description: "overwrite",
        status: "pending",
        requiredPermissions: ["write"],
        tool: "write_file",
        toolInput: { path: "rollback-task.txt", content: "dirty" },
      },
      {
        id: "s2",
        title: "fail",
        description: "missing file",
        status: "pending",
        requiredPermissions: ["read"],
        tool: "read_file",
        toolInput: { path: "__missing_rollback_probe__.txt" },
      },
    ],
  });

  const ingested = planService.persistLegacyAsDraft(plan, { originType: "legacy_ingest" });
  planService.approve(ingested.planId, ingested.version, "test");
  const result = await orchestrator.runTask(
    {
      planId: ingested.planId,
      version: ingested.version,
      autoConfirm: true,
      rollbackOnFailure: true,
    },
    false,
  );
  assert.equal(result.status, 200);
  const body = result.body as {
    rollback?: { attempted: number; restored: string[]; errors: string[] };
    plan: { steps: Array<{ status: string }> };
  };
  assert.equal(body.plan.steps[0]!.status, "completed");
  assert.equal(body.plan.steps[1]!.status, "failed");
  assert.ok(body.rollback);
  assert.equal(body.rollback!.attempted, 1);
  assert.ok(body.rollback!.restored.includes("rollback-task.txt"));
  assert.equal(await fs.readFile(target, "utf-8"), "original");
  registry.close();
});

test("Orchestrator 默认不回滚失败任务中的写操作", async () => {
  const registry = createDefaultRegistry({ dataDir });
  const { orchestrator, planService } = baseOrchestrator(registry);

  const target = path.join(sandbox, "no-rollback-task.txt");
  await fs.writeFile(target, "original", "utf-8");

  const plan = PlanSchema.parse({
    goal: "no rollback",
    steps: [
      {
        id: "s1",
        title: "write",
        description: "overwrite",
        status: "pending",
        requiredPermissions: ["write"],
        tool: "write_file",
        toolInput: { path: "no-rollback-task.txt", content: "dirty" },
      },
      {
        id: "s2",
        title: "fail",
        description: "missing file",
        status: "pending",
        requiredPermissions: ["read"],
        tool: "read_file",
        toolInput: { path: "__missing_no_rollback__.txt" },
      },
    ],
  });

  const ingested = planService.persistLegacyAsDraft(plan, { originType: "legacy_ingest" });
  planService.approve(ingested.planId, ingested.version, "test");
  const result = await orchestrator.runTask(
    { planId: ingested.planId, version: ingested.version, autoConfirm: true },
    false,
  );
  assert.equal(result.status, 200);
  const body = result.body as { rollback?: unknown };
  assert.equal(body.rollback, undefined);
  assert.equal(await fs.readFile(target, "utf-8"), "dirty");
  registry.close();
});

async function main() {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-"));
  dataDir = path.join(sandbox, "data");
  await fs.mkdir(dataDir, { recursive: true });
  ctx = new ContextManager({ dataDir, useLanceDb: false });
  runs = new RunStore(ctx.db);
  runStateStore = new RunStateStore(ctx.db);

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  \u2713 ${t.name}`);
      passed += 1;
    } catch (error) {
      console.error(`  \u2717 ${t.name}\n    ${String(error)}`);
      failed += 1;
    }
  }
  ctx.db.close();
  try {
    await fs.rm(sandbox, { recursive: true, force: true });
  } catch {
    /* Windows 上 SQLite 文件偶发 EBUSY，忽略清理失败 */
  }
  console.log(`\norchestrator: ${passed}/${tests.length} passed`);
  if (failed > 0) process.exitCode = 1;
}

void main();
