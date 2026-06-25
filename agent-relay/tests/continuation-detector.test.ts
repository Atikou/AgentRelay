/**
 * ContinuationDetector 遗留辅助函数自检。
 * 运行：npm run test:continuation-detector
 */
import assert from "node:assert/strict";

import { shouldInheritActiveTaskOnUncertain } from "../src/agent/routing/ContinuationDetector.js";
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

test("活跃 edit 任务不应被 answer fallback 打回 chat", () => {
  assert.equal(shouldInheritActiveTaskOnUncertain(activeEdit, "answer"), true);
  assert.equal(shouldInheritActiveTaskOnUncertain(activeEdit, "edit"), false);
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
