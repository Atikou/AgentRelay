/**
 * RunStateStore 与 Agent 续跑自检。
 * 运行：npm run test:run-state-store
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentLoop, type LoopChatFn } from "../src/agent/AgentLoop.js";
import { resolveRunPolicy } from "../src/agent/RunPolicy.js";
import { ContextManager } from "../src/context/ContextManager.js";
import type { ModelResponse } from "../src/model/types.js";
import { Orchestrator } from "../src/orchestrator/Orchestrator.js";
import { RunStateStore } from "../src/orchestrator/RunStateStore.js";
import {
  buildPendingWorkflowSteps,
  buildRunStateFromAgentRun,
  extractCompletedWorkflowSteps,
} from "../src/orchestrator/runStateTypes.js";
import { RunStore } from "../src/orchestrator/RunStore.js";
import { ALL_PERMISSIONS } from "../src/agent/permissions.js";
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

function scriptedChat(scripts: string[]): LoopChatFn {
  let i = 0;
  return async () => {
    const content = scripts[i] ?? '{"action":"final","answer":"脚本耗尽"}';
    i += 1;
    return {
      content,
      toolCalls: [],
      clientName: "fake",
      modelName: "fake",
      location: "local",
      latencyMs: 1,
    } satisfies ModelResponse;
  };
}

function makeOrchestrator(chat: LoopChatFn) {
  const registry = createDefaultRegistry();
  const planService = createTestPlanService({ workspaceRoot: sandbox, db: ctx.db, registry });
  return new Orchestrator({
    workspaceRoot: sandbox,
    modelRouter: {} as never,
    planner: {} as never,
    registry,
    contextManager: ctx,
    tasks: ctx.tasks,
    runs,
    runStateStore,
    notificationQueue: { drain: () => [], listPending: () => [] } as never,
    makeChatFn: () => chat,
    planService,
    projectAllowedPermissions: ALL_PERMISSIONS,
  });
}

async function seedProjectLayout() {
  await fs.mkdir(path.join(sandbox, "src", "model-router"), { recursive: true });
  await fs.writeFile(
    path.join(sandbox, "package.json"),
    JSON.stringify({ scripts: { test: "node test.js" }, dependencies: { typescript: "^5.0.0" } }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(sandbox, "src", "model-router", "route-rules.ts"),
    "export class RuleRouter {}\nexport class DecisionEngine {}\n",
    "utf-8",
  );
}

test("buildRunStateFromAgentRun 在预算耗尽且 PlanWorkflow 未完成时生成 pendingSteps", async () => {
  const goal = "请进入计划模式，只读分析当前项目模型路由模块并生成升级计划";
  const policy = resolveRunPolicy({
    requestedMode: "plan",
    budget: { maxReadCalls: 1, maxToolCalls: 3, maxModelTurns: 2 },
    message: goal,
  });
  const run = runs.create({ kind: "agent", status: "running", goal });
  const loop = new AgentLoop({
    chat: scriptedChat([
      '{"action":"tool","tool":"read_file","input":{"path":"package.json"},"thought":"继续读取"}',
    ]),
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
    policy,
    runId: run.id,
    runStateStore,
  });
  const result = await loop.run(goal);
  assert.equal(result.reachedLimit, true);
  assert.equal(result.executionMeta.budgetExhausted, "maxReadCalls");
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0]!.tool, "project_scan");

  const state = runStateStore.get(run.id);
  assert.ok(state);
  assert.equal(state!.status, "resumable");
  assert.deepEqual(state!.completedSteps, ["project_scan"]);
  assert.deepEqual(state!.pendingSteps, ["locate_relevant_files", "context_pack"]);
});

test("runId 续跑 pendingSteps 完成 PlanWorkflow 三步", async () => {
  const goal = "请进入计划模式，只读分析当前项目模型路由模块并生成升级计划";
  const chat = scriptedChat([
    '{"action":"final","answer":"续跑后已完成预扫描并生成计划"}',
  ]);

  const first = await makeOrchestrator(
    scriptedChat([
      '{"action":"tool","tool":"read_file","input":{"path":"package.json"},"thought":"继续读取"}',
    ]),
  ).runAgent({
    message: goal,
    mode: "plan",
    budget: { maxReadCalls: 1, maxToolCalls: 3, maxModelTurns: 2 },
    persist: false,
  });
  assert.equal(first.status, 200);
  const firstBody = first.body as { runId: string; reachedLimit: boolean; runState?: { pendingSteps: string[] } };
  assert.equal(firstBody.reachedLimit, true);
  assert.ok(firstBody.runState);
  assert.deepEqual(firstBody.runState!.pendingSteps, ["locate_relevant_files", "context_pack"]);

  const resumed = await makeOrchestrator(chat).resumeAgent({
    runId: firstBody.runId,
    budget: { maxReadCalls: 20, maxToolCalls: 20, maxModelTurns: 2 },
  });
  assert.equal(resumed.status, 200);
  const resumedBody = resumed.body as {
    reachedLimit: boolean;
    resumed?: boolean;
    steps: Array<{ tool: string }>;
    answer: string;
    runState?: { status: string };
  };
  assert.equal(resumedBody.resumed, true);
  assert.equal(resumedBody.reachedLimit, false);
  const workflowTools = resumedBody.steps
    .map((s) => s.tool)
    .filter((t) => t === "project_scan" || t === "locate_relevant_files" || t === "context_pack");
  assert.deepEqual(workflowTools, ["project_scan", "locate_relevant_files", "context_pack"]);
  assert.match(resumedBody.answer, /续跑后已完成预扫描/);

  const stored = runStateStore.get(firstBody.runId);
  assert.equal(stored?.status, "completed");
});

test("不可续跑 runId 返回 400", async () => {
  const run = runs.create({ kind: "agent", status: "failed", goal: "x" });
  const result = await makeOrchestrator(scriptedChat([])).resumeAgent({ runId: run.id });
  assert.equal(result.status, 400);
});

test("extractCompletedWorkflowSteps 与 buildPendingWorkflowSteps", async () => {
  const completed = extractCompletedWorkflowSteps([
    { iteration: 0, tool: "project_scan", input: {}, ok: true },
    { iteration: 0, tool: "read_file", input: {}, ok: true },
  ]);
  assert.deepEqual(completed, ["project_scan"]);
  assert.deepEqual(buildPendingWorkflowSteps(completed), [
    "locate_relevant_files",
    "context_pack",
  ]);
});

test("buildRunStateFromAgentRun 在 PlanWorkflow 已全部完成时返回 null", () => {
  const state = buildRunStateFromAgentRun({
    runId: "r1",
    goal: "只读分析当前项目结构",
    mode: "plan",
    steps: [
      { iteration: 0, tool: "project_scan", input: {}, ok: true },
      { iteration: 0, tool: "locate_relevant_files", input: {}, ok: true },
      { iteration: 0, tool: "context_pack", input: {}, ok: true },
    ],
    executionMeta: {
      mode: "plan",
      budget: resolveRunPolicy({ requestedMode: "plan", message: "x" }).budget,
      usage: {
        modelTurns: 0,
        toolCalls: 3,
        readCalls: 3,
        writeCalls: 0,
        shellCalls: 0,
        runtimeMs: 1,
      },
      usedIterations: 0,
      usedModelTurns: 0,
      usedToolCalls: 3,
      usedReadCalls: 3,
      usedWriteCalls: 0,
      usedShellCalls: 0,
      stopReason: "budget_exhausted",
      needsMoreBudget: true,
      budgetExhausted: "maxModelTurns",
    },
  });
  assert.equal(state, null);
});

let passed = 0;
let failed = 0;

async function main() {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "agent-runstate-"));
  dataDir = path.join(sandbox, "data");
  await fs.mkdir(dataDir, { recursive: true });
  ctx = new ContextManager({ dataDir, useLanceDb: false });
  runs = new RunStore(ctx.db);
  runStateStore = new RunStateStore(ctx.db);
  await seedProjectLayout();

  for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(error);
  }
}

console.log(`\nrun-state-store: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

void main();
