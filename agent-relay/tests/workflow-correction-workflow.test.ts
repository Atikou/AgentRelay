/**
 * WorkflowCorrectionWorkflow self-check.
 * Run: npm run test:workflow-correction
 */
import assert from "node:assert/strict";

import {
  MAX_WORKFLOW_CORRECTION_ATTEMPTS,
  WorkflowCorrectionWorkflow,
} from "../src/agent/WorkflowCorrectionWorkflow.js";
import type { AgentToolStep } from "../src/agent/toolStep.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

const writeStep: AgentToolStep = {
  iteration: 1,
  toolCallId: "run-1:iter-1:write_file",
  tool: "write_file",
  input: { path: "src/a.ts", content: "new" },
  permission: "write",
  ok: true,
  output: { path: "src/a.ts", changeId: "chg-1" },
};

test("injects correction phase after failed verification", () => {
  const failedVerifyStep: AgentToolStep = {
    iteration: 2,
    toolCallId: "run-1:iter-2:read_file",
    tool: "read_file",
    input: { path: "src/a.ts" },
    permission: "read",
    ok: false,
    error: "content mismatch",
  };

  const result = new WorkflowCorrectionWorkflow().run({
    goal: "edit src/a.ts",
    intent: "edit",
    steps: [writeStep, failedVerifyStep],
    currentStep: failedVerifyStep,
  });

  assert.ok(result);
  assert.equal(result.record.phase, "correction");
  assert.equal(result.record.attempt, 1);
  assert.equal(result.record.limitReached, false);
  assert.match(result.modelContext, /editWorkflow correction phase/);
  assert.match(result.modelContext, /smallest corrective tool call/);
});

test("switches to termination phase after correction limit", () => {
  const steps: AgentToolStep[] = [];
  for (let round = 0; round < MAX_WORKFLOW_CORRECTION_ATTEMPTS; round += 1) {
    steps.push({
      ...writeStep,
      iteration: round * 2 + 1,
      toolCallId: `write-${round}`,
    });
    steps.push({
      iteration: round * 2 + 2,
      toolCallId: `verify-${round}`,
      tool: "shell_run",
      input: { command: "npm test" },
      permission: "shell",
      ok: false,
      error: `failed round ${round + 1}`,
    });
  }
  const currentStep = steps.at(-1)!;

  const result = new WorkflowCorrectionWorkflow().run({
    goal: "debug failing test",
    intent: "debug",
    steps,
    currentStep,
  });

  assert.ok(result);
  assert.equal(result.record.workflowType, "debugWorkflow");
  assert.equal(result.record.phase, "termination");
  assert.equal(result.record.limitReached, true);
  assert.match(result.modelContext, /debugWorkflow termination phase/);
  assert.match(result.modelContext, /Do not call write_file/);
});

test("skips successful verification and unrelated intents", () => {
  const okVerifyStep: AgentToolStep = {
    iteration: 2,
    tool: "read_file",
    input: { path: "src/a.ts" },
    permission: "read",
    ok: true,
    output: { path: "src/a.ts", content: "new" },
  };

  assert.equal(
    new WorkflowCorrectionWorkflow().run({
      goal: "edit",
      intent: "edit",
      steps: [writeStep, okVerifyStep],
      currentStep: okVerifyStep,
    }),
    undefined,
  );
  assert.equal(
    new WorkflowCorrectionWorkflow().run({
      goal: "answer",
      intent: "answer",
      steps: [writeStep, okVerifyStep],
      currentStep: okVerifyStep,
    }),
    undefined,
  );
});

function main() {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      t.fn();
      console.log(`  ok ${t.name}`);
      passed += 1;
    } catch (error) {
      console.error(`  FAIL ${t.name}`);
      console.error(error);
      failed += 1;
    }
  }
  console.log(`\nworkflow-correction: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
