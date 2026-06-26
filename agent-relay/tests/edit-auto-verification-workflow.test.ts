/**
 * EditAutoVerificationWorkflow self-check.
 * Run: node .\node_modules\tsx\dist\cli.mjs tests\edit-auto-verification-workflow.test.ts
 */
import assert from "node:assert/strict";

import { EditAutoVerificationWorkflow } from "../src/agent/EditAutoVerificationWorkflow.js";
import type { AgentToolStep } from "../src/agent/toolStep.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("plans read_file verification for successful edit write", () => {
  const step: AgentToolStep = {
    iteration: 1,
    tool: "write_file",
    input: { path: "src/a.ts", content: "new" },
    permission: "write",
    ok: true,
    outcomeClass: "observation_success",
    output: { path: "src/a.ts", changeId: "chg-1" },
  };

  const result = new EditAutoVerificationWorkflow().run({ intent: "edit", step });

  assert.deepEqual(result?.input, { path: "src/a.ts" });
  assert.equal(result?.tool, "read_file");
  assert.match(result?.thought ?? "", /自动读回/);
});

test("skips non-edit, failed write, and missing path", () => {
  const workflow = new EditAutoVerificationWorkflow();
  const writeStep: AgentToolStep = {
    iteration: 1,
    tool: "apply_patch",
    input: {},
    permission: "write",
    ok: true,
    outcomeClass: "observation_success",
    output: { path: "src/a.ts" },
  };
  const failedWrite: AgentToolStep = {
    ...writeStep,
    ok: false,
    error: "failed",
    outcomeClass: "execution_error",
  };
  const missingPath: AgentToolStep = { ...writeStep, output: {} };

  assert.equal(workflow.run({ intent: "answer", step: writeStep }), undefined);
  assert.equal(workflow.run({ intent: "edit", step: failedWrite }), undefined);
  assert.equal(workflow.run({ intent: "generate_file", step: missingPath }), undefined);
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
  console.log(`\nedit-auto-verification-workflow: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
