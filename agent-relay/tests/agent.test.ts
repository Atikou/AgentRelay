/**
 * Agent 模式自检（无需网络）：计划解析 + 任务模式状态机。
 * 运行：npm run test:agent
 */
import assert from "node:assert/strict";

import { normalizePlan } from "../src/agent/Planner.js";
import { DryRunExecutor, TaskRunner, type StepExecutor } from "../src/agent/TaskRunner.js";
import { sortSubtasksByPriority } from "../src/agent/taskGraph.js";
import type { Plan, PlanStep } from "../src/agent/types.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

function makePlan(steps: Array<Partial<PlanStep> & { id: string; title: string }>): Plan {
  return {
    goal: "test",
    scope: { inScope: [], outOfScope: [] },
    inputs: [],
    outputs: [],
    acceptanceCriteria: [],
    risks: [],
    dependencies: [],
    steps: steps.map((s, index) => ({
      id: s.id,
      title: s.title,
      objective: s.objective ?? s.title,
      description: s.description ?? "",
      requiredPermissions: s.requiredPermissions ?? ["read"],
      needsConfirmation: s.needsConfirmation ?? false,
      acceptance: s.acceptance,
      dependsOn: s.dependsOn ?? [],
      requiredContext: s.requiredContext ?? [],
      availableTools: s.availableTools ?? ["read_file"],
      expectedArtifacts: s.expectedArtifacts ?? [],
      priority: s.priority ?? (index + 1) * 10,
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

test("normalizePlan 解析子任务元数据并拓扑排序", async () => {
  const content = JSON.stringify({
    goal: "实现登录",
    inputs: ["现有用户表"],
    outputs: ["登录 API"],
    acceptanceCriteria: ["单元测试通过"],
    steps: [
      {
        id: "b",
        title: "实现接口",
        objective: "完成 POST /login",
        dependsOn: ["a"],
        requiredContext: ["src/auth.ts"],
        availableTools: ["read_file", "write_file"],
        expectedArtifacts: ["src/routes/login.ts"],
        acceptance: "curl 返回 200",
        priority: 20,
        requiredPermissions: ["write"],
      },
      {
        id: "a",
        title: "调研现状",
        objective: "阅读现有认证代码",
        requiredContext: ["README"],
        expectedArtifacts: ["调研笔记"],
        acceptance: "列出改动点",
        priority: 10,
        requiredPermissions: ["read"],
      },
    ],
  });
  const plan = normalizePlan(content, "fallback");
  assert.equal(plan.inputs[0], "现有用户表");
  assert.equal(plan.outputs[0], "登录 API");
  assert.equal(plan.steps[0]!.id, "a");
  assert.equal(plan.steps[1]!.id, "b");
  assert.equal(plan.steps[0]!.objective, "阅读现有认证代码");
  assert.ok(plan.steps[1]!.availableTools.includes("write_file"));
  assert.equal(plan.steps[1]!.expectedArtifacts[0], "src/routes/login.ts");
});

test("sortSubtasksByPriority 同层按 priority 排序", async () => {
  const sorted = sortSubtasksByPriority([
    {
      id: "b",
      title: "B",
      description: "",
      requiredPermissions: ["read"],
      needsConfirmation: false,
      dependsOn: [],
      requiredContext: [],
      availableTools: [],
      expectedArtifacts: [],
      priority: 20,
      status: "pending",
    },
    {
      id: "a",
      title: "A",
      description: "",
      requiredPermissions: ["read"],
      needsConfirmation: false,
      dependsOn: [],
      requiredContext: [],
      availableTools: [],
      expectedArtifacts: [],
      priority: 10,
      status: "pending",
    },
  ]);
  assert.deepEqual(
    sorted.map((s) => s.id),
    ["a", "b"],
  );
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
    { id: "b", title: "B", dependsOn: ["a"] },
    { id: "c", title: "C", dependsOn: ["b"] },
  ]);
  const runner = new TaskRunner(plan, { executor: new FailingExecutor("b"), autoConfirm: true });
  const result = await runner.run();
  assert.equal(result.steps[0]!.status, "completed");
  assert.equal(result.steps[1]!.status, "failed");
  assert.equal(result.steps[2]!.status, "blocked");
  assert.match(result.steps[2]!.error ?? "", /依赖步骤 b/);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("TaskRunner dependsOn 串行执行", async () => {
  const order: string[] = [];
  const executor: StepExecutor = {
    async execute(step) {
      order.push(step.id);
      return { output: "ok" };
    },
  };
  const plan = makePlan([
    { id: "a", title: "A" },
    { id: "b", title: "B", dependsOn: ["a"] },
  ]);
  const runner = new TaskRunner(plan, { executor, autoConfirm: true });
  await runner.run();
  assert.deepEqual(order, ["a", "b"]);
});

test("TaskRunner 无依赖步骤并行执行", async () => {
  const active = new Set<string>();
  let maxConcurrent = 0;
  const executor: StepExecutor = {
    async execute(step) {
      active.add(step.id);
      maxConcurrent = Math.max(maxConcurrent, active.size);
      await sleep(30);
      active.delete(step.id);
      return { output: "ok" };
    },
  };
  const plan = makePlan([
    { id: "a", title: "A" },
    { id: "b", title: "B" },
  ]);
  const runner = new TaskRunner(plan, { executor, autoConfirm: true });
  const result = await runner.run();
  assert.equal(maxConcurrent, 2);
  assert.deepEqual(
    result.steps.map((s) => s.status),
    ["completed", "completed"],
  );
});

test("TaskRunner 菱形依赖汇聚后执行", async () => {
  const order: string[] = [];
  const executor: StepExecutor = {
    async execute(step) {
      order.push(step.id);
      await sleep(10);
      return { output: "ok" };
    },
  };
  const plan = makePlan([
    { id: "a", title: "A" },
    { id: "b", title: "B" },
    { id: "c", title: "C", dependsOn: ["a", "b"] },
  ]);
  const runner = new TaskRunner(plan, { executor, autoConfirm: true });
  await runner.run();
  assert.equal(order[order.length - 1], "c");
  assert.ok(order.indexOf("a") < order.indexOf("c"));
  assert.ok(order.indexOf("b") < order.indexOf("c"));
});

test("TaskRunner 阻塞时继续执行无依赖的其他步骤", async () => {
  const executed: string[] = [];
  const plan = makePlan([
    {
      id: "a",
      title: "需确认",
      requiredPermissions: ["write"],
      needsConfirmation: true,
    },
    { id: "b", title: "只读分支", requiredPermissions: ["read"] },
    { id: "c", title: "依赖 a", requiredPermissions: ["read"], dependsOn: ["a"] },
  ]);
  const runner = new TaskRunner(plan, {
    executor: {
      async execute(step) {
        executed.push(step.id);
        return { output: "ok" };
      },
    },
    confirm: async () => false,
  });
  const result = await runner.run();
  assert.equal(result.steps[0]!.status, "blocked");
  assert.equal(result.steps[1]!.status, "completed");
  assert.equal(result.steps[2]!.status, "blocked");
  assert.ok(executed.includes("b"));
  assert.equal(executed.includes("c"), false);
});

test("TaskRunner failed 后不再启动新波次", async () => {
  const executed: string[] = [];
  const plan = makePlan([
    { id: "a", title: "A" },
    { id: "b", title: "B", dependsOn: ["a"] },
    { id: "c", title: "独立 C" },
  ]);
  const runner = new TaskRunner(plan, {
    executor: {
      async execute(step) {
        executed.push(step.id);
        if (step.id === "a") throw new Error("boom");
        return { output: "ok" };
      },
    },
    autoConfirm: true,
  });
  const result = await runner.run();
  assert.equal(result.steps[0]!.status, "failed");
  assert.equal(result.steps[1]!.status, "blocked");
  assert.equal(result.steps[2]!.status, "completed");
  assert.deepEqual([...executed].sort(), ["a", "c"]);
});

test("TaskRunner 拒绝循环依赖", async () => {
  const plan = makePlan([
    { id: "a", title: "A", dependsOn: ["b"] },
    { id: "b", title: "B", dependsOn: ["a"] },
  ]);
  const runner = new TaskRunner(plan, { executor: new DryRunExecutor(), autoConfirm: true });
  await assert.rejects(() => runner.run(), /环/);
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
