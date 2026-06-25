/**
 * WorkflowStateCenter self-check.
 * Run: npm run test:workflow-state-center
 */
import assert from "node:assert/strict";

import { buildWorkflowState } from "../src/agent/WorkflowStateCenter.js";
import type { AgentToolStep } from "../src/agent/toolStep.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

const writeStep: AgentToolStep = {
  iteration: 1,
  toolCallId: "write-1",
  tool: "write_file",
  input: { path: "src/a.ts", content: "new" },
  permission: "write",
  ok: true,
  output: { path: "src/a.ts" },
};

test("tracks pending verification after write", () => {
  const state = buildWorkflowState({
    intent: "edit",
    steps: [writeStep],
    hasProposal: true,
    maxCorrectionAttempts: 2,
  });

  assert.equal(state.phase, "write_pending_verification");
  assert.equal(state.requiresVerificationBeforeNextWrite, true);
  assert.equal(state.priorWrites, 1);
  assert.equal(state.lastWriteToolCallId, "write-1");
  assert.equal(state.taskState, "verifying");
});

test("tracks correction limit as termination", () => {
  const failedVerify: AgentToolStep = {
    iteration: 2,
    toolCallId: "verify-1",
    tool: "shell_run",
    input: { command: "npm test" },
    permission: "shell",
    ok: false,
    executed: true,
    outcomeClass: "observation_failure",
    outcomeKind: "command_failed",
    error: "failed",
  };
  const state = buildWorkflowState({
    intent: "debug",
    steps: [writeStep, failedVerify],
    hasDebugAnalysis: true,
    maxCorrectionAttempts: 1,
  });

  assert.equal(state.phase, "terminated");
  assert.equal(state.correctionLimitReached, true);
  assert.equal(state.taskState, "failed");
  assert.equal(state.events.at(-1)?.type, "correction_limit_reached");
});

test("outcomeClass observation_success 计入写入与验证", () => {
  const writeWithOutcome: AgentToolStep = {
    ...writeStep,
    executed: true,
    outcomeClass: "observation_success",
    outcomeKind: "ok",
  };
  const verifyRead: AgentToolStep = {
    iteration: 2,
    toolCallId: "verify-read",
    tool: "read_file",
    input: { path: "src/a.ts" },
    permission: "read",
    ok: true,
    executed: true,
    outcomeClass: "observation_success",
    outcomeKind: "ok",
  };
  const state = buildWorkflowState({
    intent: "edit",
    steps: [writeWithOutcome, verifyRead],
    hasProposal: true,
    maxCorrectionAttempts: 2,
  });
  assert.equal(state.phase, "verification_passed");
  assert.equal(state.lastVerificationOk, true);
});

let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`  ok ${t.name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${t.name}`);
    console.error(error);
  }
}
console.log(`\nworkflow-state-center: ${tests.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
