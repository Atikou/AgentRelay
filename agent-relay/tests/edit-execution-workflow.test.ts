/**
 * EditExecutionWorkflow self-check.
 * Run: node .\node_modules\tsx\dist\cli.mjs tests\edit-execution-workflow.test.ts
 */
import assert from "node:assert/strict";

import { EditExecutionWorkflow } from "../src/agent/EditExecutionWorkflow.js";
import type { AgentToolStep } from "../src/agent/toolStep.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("renders execution context for successful edit write", () => {
  const step: AgentToolStep = {
    iteration: 1,
    toolCallId: "run-1:iter-1:apply_patch",
    tool: "apply_patch",
    input: { path: "src/a.ts", search: "old", replace: "new" },
    permission: "write",
    ok: true,
    output: { path: "src/a.ts", changeId: "chg-1", diff: "-old\n+new" },
  };

  const result = new EditExecutionWorkflow().run({
    goal: "edit src/a.ts",
    intent: "edit",
    step,
  });

  assert.ok(result);
  assert.match(result.modelContext, /editWorkflow execution phase/);
  assert.match(result.modelContext, /writeTool: apply_patch/);
  assert.match(result.modelContext, /changeId: chg-1/);
  assert.match(result.modelContext, /-old/);
  assert.match(result.modelContext, /smallest useful verification/);
});

test("skips non-write and non-edit paths", () => {
  const readStep: AgentToolStep = {
    iteration: 1,
    tool: "read_file",
    input: { path: "src/a.ts" },
    permission: "read",
    ok: true,
    output: { path: "src/a.ts", content: "x" },
  };

  const workflow = new EditExecutionWorkflow();
  assert.equal(workflow.run({ goal: "answer", intent: "answer", step: readStep }), undefined);
  assert.equal(workflow.run({ goal: "edit", intent: "edit", step: readStep }), undefined);
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
  console.log(`\nedit-execution-workflow: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
