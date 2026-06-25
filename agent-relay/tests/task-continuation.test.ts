/**
 * TaskContinuationEngine 任务延续评分自检。
 * 运行：npm run test:task-continuation
 */
import assert from "node:assert/strict";

import { extractMessageContinuationSignals } from "../src/agent/routing/MessageSignalExtractor.js";
import {
  evaluateTaskContinuation,
  shouldGuardrailOverrideAiClassifier,
} from "../src/agent/routing/TaskContinuationEngine.js";
import type { TaskContext } from "../src/agent/task/TaskContext.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

const completedEdit: TaskContext = {
  sessionId: "s1",
  taskId: "task-1",
  currentPhase: "completed",
  intent: "edit",
  workflowType: "editWorkflow",
  isActive: true,
  lastStopReason: "completed",
  lastSideEffectSummary: { wroteFiles: ["testTS/src/index.ts"], ranShell: false },
  updatedAt: new Date().toISOString(),
};

test("再好看壮观一点 + 活跃 implement 任务 → inherit（非关键词映射 mode）", () => {
  const message = "再好看壮观一点";
  const signals = extractMessageContinuationSignals(message);
  const decision = evaluateTaskContinuation(message, completedEdit, signals);
  assert.equal(decision.kind, "inherit");
  assert.equal(decision.inheritIntent, "edit");
  assert.equal(decision.inheritWorkflowType, "editWorkflow");
  assert.ok(decision.score >= 0.55);
  assert.equal(signals.hasAnaphora, true);
});

test("显式审阅请求不继承副作用任务", () => {
  const message = "只帮我审查一下，不要修改";
  const signals = extractMessageContinuationSignals(message);
  const decision = evaluateTaskContinuation(message, completedEdit, signals);
  assert.equal(decision.kind, "uncertain");
  assert.equal(signals.explicitReadonlyRequest, true);
});

test("AI 降级 review 时 guardrail 继承活跃 edit", () => {
  const message = "再好看壮观一点";
  const signals = extractMessageContinuationSignals(message);
  const continuation = evaluateTaskContinuation(message, completedEdit, signals);
  assert.equal(
    shouldGuardrailOverrideAiClassifier({
      ctx: completedEdit,
      aiIntent: "review",
      aiIsContinuation: false,
      continuation,
    }),
    true,
  );
});

test("无活跃任务时不继承", () => {
  const message = "再好看壮观一点";
  const signals = extractMessageContinuationSignals(message);
  const decision = evaluateTaskContinuation(message, undefined, signals);
  assert.equal(decision.kind, "uncertain");
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
console.log(`\ntask-continuation: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
