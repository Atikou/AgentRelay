/**
 * ContinuationDetector 自检。
 * 运行：npm run test:continuation-detector
 */
import assert from "node:assert/strict";

import {
  detectContinuation,
  isExplicitNewTaskMessage,
  shouldInheritActiveTaskOnUncertain,
} from "../src/agent/routing/ContinuationDetector.js";
import type { TaskContext } from "../src/agent/task/TaskContext.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

const activeEdit: TaskContext = {
  sessionId: "s1",
  currentPhase: "editing",
  intent: "edit",
  workflowType: "editWorkflow",
  isActive: true,
  updatedAt: new Date().toISOString(),
};

test("粘贴工具失败步骤识别为延续", () => {
  const pasted = ["#2 read_file", '入参 {"path":"a.ts"}', "[error] ENOENT"].join("\n");
  const result = detectContinuation(pasted, activeEdit);
  assert.equal(result.kind, "continuation");
  assert.equal(result.inheritIntent, "edit");
});

test("明确换话题识别为新任务", () => {
  assert.equal(isExplicitNewTaskMessage("换个问题，Vue 和 React 怎么选"), true);
  const result = detectContinuation("换个问题", activeEdit);
  assert.equal(result.kind, "new_task");
});

test("活跃 edit 任务不应被 answer fallback 打回 chat", () => {
  assert.equal(shouldInheritActiveTaskOnUncertain(activeEdit, "answer"), true);
  assert.equal(shouldInheritActiveTaskOnUncertain(activeEdit, "edit"), false);
});

test("失败后短补充说明视为延续", () => {
  const failed: TaskContext = {
    ...activeEdit,
    currentPhase: "failed",
    lastFailure: "read_file ENOENT",
  };
  const result = detectContinuation("还是找不到 vite.config.ts", failed);
  assert.equal(result.kind, "continuation");
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`  ok ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(error);
  }
}
console.log(`\ncontinuation-detector: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
