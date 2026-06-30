/**
 * TaskBoundaryDecision 任务边界与副作用兼容性自检。
 * 运行：npx tsx tests/task-boundary.test.ts
 */
import assert from "node:assert/strict";

import { inferRequiredSideEffectsFromGoal } from "../src/agent/completion/TaskCompletionContract.js";
import {
  evaluateTaskBoundary,
  workflowDirectlyAllowsSideEffects,
  workflowSatisfiesSideEffects,
} from "../src/agent/routing/TaskBoundaryDecision.js";
import { extractMessageContinuationSignals } from "../src/agent/routing/MessageSignalExtractor.js";
import type { TaskContext } from "../src/agent/task/TaskContext.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

const generateFileCtx: TaskContext = {
  sessionId: "s1",
  taskId: "t1",
  goal: "执行增强方案",
  currentPhase: "completed",
  intent: "generate_file",
  workflowType: "generateFileWorkflow",
  isActive: true,
  updatedAt: new Date().toISOString(),
};

test("安装依赖 goal 推断 shell 副作用", () => {
  assert.deepEqual(inferRequiredSideEffectsFromGoal("安装依赖"), ["shell"]);
});

test("问答 goal 无 write/shell 副作用", () => {
  assert.deepEqual(inferRequiredSideEffectsFromGoal("依赖是全局的还是项目的"), []);
});

test("generateFileWorkflow 直接能力不含 shell，但 soft workflow 可升级满足", () => {
  assert.equal(workflowDirectlyAllowsSideEffects("generateFileWorkflow", ["shell"]), false);
  assert.equal(workflowSatisfiesSideEffects("generateFileWorkflow", ["shell"]), true);
  assert.equal(workflowSatisfiesSideEffects("runWorkflow", ["shell"]), true);
});

test("安装依赖 + generate_file 活跃任务 → breaksContinuation", () => {
  const message = "安装依赖";
  const signals = extractMessageContinuationSignals(message);
  const boundary = evaluateTaskBoundary(message, generateFileCtx, signals);
  assert.equal(boundary.hasExplicitActionAnchor, true);
  assert.deepEqual(boundary.requiredSideEffects, ["shell"]);
  assert.equal(boundary.breaksContinuation, true);
});

test("再好看壮观一点 + edit 活跃任务 → 不打断", () => {
  const editCtx: TaskContext = {
    ...generateFileCtx,
    intent: "edit",
    workflowType: "editWorkflow",
  };
  const message = "再好看壮观一点";
  const signals = extractMessageContinuationSignals(message);
  const boundary = evaluateTaskBoundary(message, editCtx, signals);
  assert.equal(boundary.breaksContinuation, false);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    throw error;
  }
}
console.log(`task-boundary: ${passed}/${tests.length} passed`);
