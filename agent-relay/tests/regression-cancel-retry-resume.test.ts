/**
 * 回归：失败重试、取消与恢复（跨模块链路）。
 * 运行：npm run test:regression-cancel-retry-resume
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LoopChatFn } from "../src/agent/AgentLoop.js";
import { DryRunExecutor, TaskRunner, type StepExecutor } from "../src/agent/TaskRunner.js";
import type { Plan, PlanStep } from "../src/agent/types.js";
import { ContextManager } from "../src/context/ContextManager.js";
import type { ModelResponse } from "../src/model/types.js";
import { RunStore } from "../src/orchestrator/RunStore.js";
import { RunStateStore } from "../src/orchestrator/RunStateStore.js";
import { ALL_PERMISSIONS } from "../src/core/permissions.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import { createTestPlanService } from "./planTestHelper.js";
import { createTestOrchestrator } from "./orchestratorTestHelper.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

let sandbox = "";
let dataDir = "";
let ctx: ContextManager;
let runs: RunStore;
let runStateStore: RunStateStore;

function makePlan(steps: Array<Partial<PlanStep> & { id: string; title: string }>): Plan {
  return {
    goal: "回归任务",
    steps: steps.map((s, index) => ({
      id: s.id,
      title: s.title,
      objective: s.objective ?? s.title,
      description: s.description ?? "",
      requiredPermissions: s.requiredPermissions ?? ["read"],
      needsConfirmation: s.needsConfirmation ?? false,
      dependsOn: s.dependsOn ?? [],
      priority: s.priority ?? (index + 1) * 10,
      status: s.status ?? "pending",
    })),
  };
}

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

function hangingChat(): LoopChatFn {
  return async (req) => {
    await new Promise<never>((_resolve, reject) => {
      const signal = req.signal;
      if (!signal) {
        reject(new Error("回归测试需要 abort signal"));
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
}

function makeOrchestrator(chat: LoopChatFn) {
  const registry = createDefaultRegistry({ dataDir });
  const planService = createTestPlanService({ workspaceRoot: sandbox, db: ctx.db, registry });
  const { orchestrator } = createTestOrchestrator({
    workspaceRoot: sandbox,
    directChat: {} as never,
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
  return { orchestrator, registry };
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

test("回归：TaskRunner 失败步骤 retryFrom 后 completed", async () => {
  const plan = makePlan([
    { id: "a", title: "A", status: "pending" },
    { id: "b", title: "B", status: "pending" },
  ]);
  let failB = true;
  const executor: StepExecutor = {
    async execute(step) {
      if (step.id === "b" && failB) throw new Error("临时失败");
      return { output: "ok" };
    },
  };
  const runner = new TaskRunner(plan, { executor, autoConfirm: true });
  await runner.run();
  assert.equal(plan.steps[1]!.status, "failed");

  failB = false;
  const planAfterRetry = await runner.retryFrom("b");
  assert.equal(planAfterRetry.steps[1]!.status, "completed");
  assert.equal(planAfterRetry.steps[0]!.status, "completed");
});

test("回归：TaskRunner cancel 后剩余步骤均为 cancelled", async () => {
  const plan = makePlan([
    { id: "a", title: "A", status: "pending" },
    { id: "b", title: "B", status: "pending" },
  ]);
  const runner = new TaskRunner(plan, { executor: new DryRunExecutor(), autoConfirm: true });
  runner.cancel();
  const result = await runner.run();
  assert.deepEqual(
    result.steps.map((s) => s.status),
    ["cancelled", "cancelled"],
  );
});

test("回归：TaskRunner blocked 后 resume(confirm) 完成", async () => {
  const plan: Plan = {
    goal: "确认门回归",
    steps: [
      {
        id: "confirm-1",
        title: "需确认写",
        requiredPermissions: ["write"],
        needsConfirmation: true,
        status: "pending",
      },
      {
        id: "free",
        title: "只读",
        requiredPermissions: ["read"],
        status: "pending",
      },
    ],
  };
  const runner = new TaskRunner(structuredClone(plan), { executor: new DryRunExecutor(), autoConfirm: false });
  const afterBlock = await runner.run();
  assert.equal(afterBlock.steps[0]!.status, "blocked");

  const resumed = await runner.resume("confirm", "confirm-1");
  assert.equal(resumed.steps[0]!.status, "completed");
  assert.equal(resumed.steps[1]!.status, "completed");
});

test("回归：非流式 Agent 取消后 run cancelled 且不可 resume", async () => {
  const chat = hangingChat();
  const { orchestrator, registry } = makeOrchestrator(chat);

  const runPromise = orchestrator.runAgent({ message: "取消回归探测", persist: false }, chat);

  let cancelledRunId = "";
  for (let i = 0; i < 50; i++) {
    const running = orchestrator.listRunningAgentRuns();
    if (running.length > 0) {
      cancelledRunId = running[0]!.runId;
      const cancel = orchestrator.cancelRun(cancelledRunId);
      assert.equal(cancel.status, 200);
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(cancelledRunId, "应在运行中注册 runId");

  const result = await runPromise;
  assert.equal(result.status, 200);
  const body = result.body as {
    runId: string;
    executionMeta: { stopReason: string };
    answer: string;
  };
  assert.equal(body.executionMeta.stopReason, "user_cancelled");
  assert.match(body.answer, /已取消/);

  const run = runs.get(body.runId);
  assert.equal(run?.status, "cancelled");

  const resume = await orchestrator.resumeAgent({ runId: body.runId });
  assert.equal(resume.status, 400);
  assert.match(String((resume.body as { error?: string }).error), /不可续跑/);

  registry.close();
});

test("回归：预算耗尽 resumable 后 resume 可完成", async () => {
  await seedProjectLayout();
  const goal = "请进入计划模式，只读分析当前项目模型路由模块并生成升级计划";
  const { orchestrator, registry } = makeOrchestrator(
    scriptedChat([
      '{"action":"tool","tool":"read_file","input":{"path":"package.json"},"thought":"继续读取"}',
    ]),
  );

  const first = await orchestrator.runAgent({
    message: goal,
    mode: "plan",
    budget: { maxReadCalls: 1, maxToolCalls: 3, maxModelTurns: 2 },
    persist: false,
  });
  assert.equal(first.status, 200);
  const firstBody = first.body as {
    runId: string;
    reachedLimit: boolean;
    runState?: { status: string; pendingSteps: string[] };
  };
  assert.equal(firstBody.reachedLimit, true);
  assert.ok(firstBody.runState);
  assert.equal(firstBody.runState!.status, "resumable");
  assert.ok(firstBody.runState!.pendingSteps.length > 0);

  const { orchestrator: resumeOrch } = makeOrchestrator(
    scriptedChat(['{"action":"final","answer":"回归续跑已完成"}']),
  );
  const resumed = await resumeOrch.resumeAgent({
    runId: firstBody.runId,
    budget: { maxReadCalls: 20, maxToolCalls: 20, maxModelTurns: 2 },
  });
  assert.equal(resumed.status, 200);
  const resumedBody = resumed.body as { resumed?: boolean; answer: string; reachedLimit: boolean };
  assert.equal(resumedBody.resumed, true);
  assert.equal(resumedBody.reachedLimit, false);
  assert.match(resumedBody.answer, /回归续跑已完成/);

  registry.close();
});

async function main() {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "agent-regression-"));
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
      console.log(`  ✓ ${t.name}`);
      passed += 1;
    } catch (error) {
      console.error(`  ✗ ${t.name}\n    ${String(error)}`);
      failed += 1;
    }
  }
  ctx.db.close();
  try {
    await fs.rm(sandbox, { recursive: true, force: true });
  } catch {
    /* Windows 偶发 EBUSY */
  }
  console.log(`\nregression-cancel-retry-resume: ${passed}/${tests.length} passed`);
  if (failed > 0) process.exitCode = 1;
}

void main();
