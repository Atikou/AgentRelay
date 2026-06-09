/**
 * Agent 模式自检（无需网络）：计划解析 + 任务模式状态机。
 * 运行：npm run test:agent
 */
import assert from "node:assert/strict";

import { normalizePlan } from "../src/agent/Planner.js";
import { DryRunExecutor, TaskRunner, type StepExecutor } from "../src/agent/TaskRunner.js";
import type { Plan, PlanStep } from "../src/agent/types.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

function makePlan(steps: Array<Partial<PlanStep> & { id: string; title: string }>): Plan {
  return {
    goal: "test",
    scope: { inScope: [], outOfScope: [] },
    risks: [],
    dependencies: [],
    steps: steps.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description ?? "",
      requiredPermissions: s.requiredPermissions ?? ["read"],
      needsConfirmation: s.needsConfirmation ?? false,
      acceptance: s.acceptance,
      status: s.status ?? "pending",
    })),
  };
}

class FailingExecutor implements StepExecutor {
  constructor(private readonly failId: string) {}
  async execute(step: PlanStep) {
    if (step.id === this.failId) throw new Error("boom");
    return { output: "ok" };
  }
}

test("normalizePlan 解析带围栏的 JSON 并补全 id/确认标志", async () => {
  const content =
    '```json\n{"goal":"G","steps":[{"title":"读取文件","requiredPermissions":["read"]},{"title":"写文件","requiredPermissions":["write"]}]}\n```';
  const plan = normalizePlan(content, "fallback");
  assert.equal(plan.goal, "G");
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0]!.id, "step-1");
  assert.equal(plan.steps[0]!.needsConfirmation, false);
  // write 权限应自动需要确认
  assert.equal(plan.steps[1]!.needsConfirmation, true);
});

test("normalizePlan 纯文本无 JSON 时抛错", async () => {
  await assert.rejects(async () => normalizePlan("这里没有 JSON", "g"));
});

test("TaskRunner 顺序执行全部完成", async () => {
  const plan = makePlan([
    { id: "a", title: "A" },
    { id: "b", title: "B" },
  ]);
  const runner = new TaskRunner(plan, { executor: new DryRunExecutor(), autoConfirm: true });
  const result = await runner.run();
  assert.deepEqual(
    result.steps.map((s) => s.status),
    ["completed", "completed"],
  );
});

test("失败步骤标记 failed 并停止后续", async () => {
  const plan = makePlan([
    { id: "a", title: "A" },
    { id: "b", title: "B" },
    { id: "c", title: "C" },
  ]);
  const runner = new TaskRunner(plan, { executor: new FailingExecutor("b"), autoConfirm: true });
  const result = await runner.run();
  assert.equal(result.steps[0]!.status, "completed");
  assert.equal(result.steps[1]!.status, "failed");
  assert.equal(result.steps[2]!.status, "pending");
});

test("需确认步骤在拒绝时阻塞", async () => {
  const plan = makePlan([
    { id: "a", title: "写文件", requiredPermissions: ["write"], needsConfirmation: true },
  ]);
  const runner = new TaskRunner(plan, {
    executor: new DryRunExecutor(),
    confirm: async () => false,
  });
  const result = await runner.run();
  assert.equal(result.steps[0]!.status, "blocked");
});

test("需确认步骤在同意时执行", async () => {
  const plan = makePlan([
    { id: "a", title: "写文件", requiredPermissions: ["write"], needsConfirmation: true },
  ]);
  const runner = new TaskRunner(plan, {
    executor: new DryRunExecutor(),
    confirm: async () => true,
  });
  const result = await runner.run();
  assert.equal(result.steps[0]!.status, "completed");
});

test("权限超出允许集时阻塞", async () => {
  const plan = makePlan([
    { id: "a", title: "执行命令", requiredPermissions: ["shell"], needsConfirmation: false },
  ]);
  const runner = new TaskRunner(plan, {
    executor: new DryRunExecutor(),
    autoConfirm: true,
    allowedPermissions: ["read", "write"], // 不含 shell
  });
  const result = await runner.run();
  assert.equal(result.steps[0]!.status, "blocked");
});

test("cancel 后剩余步骤标记 cancelled", async () => {
  const plan = makePlan([
    { id: "a", title: "A" },
    { id: "b", title: "B" },
  ]);
  const runner = new TaskRunner(plan, { executor: new DryRunExecutor(), autoConfirm: true });
  runner.cancel();
  const result = await runner.run();
  assert.deepEqual(
    result.steps.map((s) => s.status),
    ["cancelled", "cancelled"],
  );
});

test("retryFrom 重跑失败步骤", async () => {
  const plan = makePlan([
    { id: "a", title: "A" },
    { id: "b", title: "B" },
  ]);
  let failB = true;
  const executor: StepExecutor = {
    async execute(step) {
      if (step.id === "b" && failB) throw new Error("temp");
      return { output: "ok" };
    },
  };
  const runner = new TaskRunner(plan, { executor, autoConfirm: true });
  await runner.run();
  assert.equal(plan.steps[1]!.status, "failed");

  failB = false;
  const result = await runner.retryFrom("b");
  assert.equal(result.steps[1]!.status, "completed");
});

async function main() {
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
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

void main();
