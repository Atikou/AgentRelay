/**
 * EditVerificationWorkflow self-check.
 * Run: node .\node_modules\tsx\dist\cli.mjs tests\edit-verification-workflow.test.ts
 */
import assert from "node:assert/strict";

import { EditVerificationWorkflow } from "../src/agent/EditVerificationWorkflow.js";
import type { AgentToolStep } from "../src/agent/toolStep.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("renders verification context after edit write", () => {
  const writeStep: AgentToolStep = {
    iteration: 1,
    toolCallId: "run-1:iter-1:write_file",
    tool: "write_file",
    input: { path: "src/a.ts", content: "new" },
    permission: "write",
    ok: true,
    output: { path: "src/a.ts", changeId: "chg-1", diff: "-old\n+new" },
  };
  const verifyStep: AgentToolStep = {
    iteration: 2,
    toolCallId: "run-1:iter-2:read_file",
    tool: "read_file",
    input: { path: "src/a.ts" },
    permission: "read",
    ok: true,
    output: { path: "src/a.ts", content: "new" },
  };

  const result = new EditVerificationWorkflow().run({
    goal: "edit src/a.ts",
    intent: "edit",
    steps: [writeStep, verifyStep],
    currentStep: verifyStep,
  });

  assert.ok(result);
  assert.equal(result.record.workflowType, "editWorkflow");
  assert.equal(result.record.path, "src/a.ts");
  assert.equal(result.record.changeId, "chg-1");
  assert.equal(result.record.verificationTool, "read_file");
  assert.equal(result.record.ok, true);
  assert.match(result.modelContext, /editWorkflow verification phase/);
  assert.match(result.modelContext, /verificationStatus: completed/);
  assert.match(result.modelContext, /return final/);
});

test("collects failed verification but skips unrelated tools", () => {
  const writeStep: AgentToolStep = {
    iteration: 1,
    tool: "apply_patch",
    input: { path: "src/a.ts" },
    permission: "write",
    ok: true,
    output: { path: "src/a.ts", changeId: "chg-2" },
  };
  const failedVerifyStep: AgentToolStep = {
    iteration: 2,
    tool: "shell_run",
    input: { command: "npm test" },
    permission: "shell",
    ok: false,
    error: "[exit_1] tests failed",
  };
  const unrelatedStep: AgentToolStep = {
    iteration: 3,
    tool: "write_file",
    input: { path: "other.txt", content: "x" },
    permission: "write",
    ok: true,
    output: { path: "other.txt" },
  };

  const workflow = new EditVerificationWorkflow();
  const records = workflow.collect("generate_file", [writeStep, failedVerifyStep, unrelatedStep]);

  assert.equal(records.length, 1);
  assert.equal(records[0]?.workflowType, "generateFileWorkflow");
  assert.equal(records[0]?.verificationTool, "shell_run");
  assert.equal(records[0]?.ok, false);
  assert.match(records[0]?.error ?? "", /tests failed/);
  assert.equal(workflow.run({ goal: "answer", intent: "answer", steps: [failedVerifyStep], currentStep: failedVerifyStep }), undefined);
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
  console.log(`\nedit-verification-workflow: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
