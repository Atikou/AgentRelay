/**
 * 任务状态流转与 resume（retry/skip/confirm）。
 */
import assert from "node:assert/strict";

import { planFromTask } from "../src/agent/planFromTask.js";
import { aggregateTaskStatus } from "../src/agent/taskStatus.js";
import { DryRunExecutor, TaskRunner } from "../src/agent/TaskRunner.js";
import type { Plan } from "../src/agent/types.js";

const blockedPlan: Plan = {
  goal: "确认门阻塞",
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

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("aggregateTaskStatus 识别 blocked / completed", () => {
  assert.equal(
    aggregateTaskStatus([
      { ...blockedPlan.steps[0]!, status: "blocked" },
      { ...blockedPlan.steps[1]!, status: "completed" },
    ]),
    "blocked",
  );
  assert.equal(
    aggregateTaskStatus([
      { ...blockedPlan.steps[0]!, status: "skipped" },
      { ...blockedPlan.steps[1]!, status: "completed" },
    ]),
    "completed",
  );
});

test("confirm 后 blocked 步骤可继续 dry-run", async () => {
  const runner = new TaskRunner(structuredClone(blockedPlan), {
    executor: new DryRunExecutor(),
    autoConfirm: false,
  });
  const afterBlock = await runner.run();
  assert.equal(afterBlock.steps[0]?.status, "blocked");
  const resumed = await runner.resume("confirm", "confirm-1");
  assert.equal(resumed.steps[0]?.status, "completed");
  assert.equal(resumed.steps[1]?.status, "completed");
});

test("skip 跳过后依赖可继续", async () => {
  const plan: Plan = {
    goal: "跳过阻塞步",
    steps: [
      {
        id: "block",
        title: "阻塞",
        requiredPermissions: ["write"],
        needsConfirmation: true,
        status: "blocked",
        error: "等待用户确认",
      },
      {
        id: "after",
        title: "后续",
        requiredPermissions: ["read"],
        dependsOn: ["block"],
        status: "pending",
      },
    ],
  };
  const runner = new TaskRunner(plan, { executor: new DryRunExecutor(), autoConfirm: false });
  const result = await runner.resume("skip", "block");
  assert.equal(result.steps[0]?.status, "skipped");
  assert.equal(result.steps[1]?.status, "completed");
});

test("planFromTask 往返步骤元数据", () => {
  const task = {
    id: "t1",
    goal: "g",
    status: "blocked",
    sessionId: "s1",
    inputs: ["a"],
    outputs: ["b"],
    acceptanceCriteria: ["c"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const steps = [
    {
      id: "row1",
      taskId: "t1",
      stepId: "s1",
      position: 0,
      title: "步骤",
      objective: "目标",
      description: "描述",
      status: "blocked",
      requiredPermissions: ["read"] as const,
      needsConfirmation: false,
      dependsOn: [] as string[],
      priority: 10,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    },
  ];
  const plan = planFromTask(task, steps);
  assert.equal(plan.steps[0]?.objective, "目标");
  assert.equal(plan.steps[0]?.status, "blocked");
});

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
console.log(`\ntask-resume: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
