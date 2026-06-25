/**
 * WorkflowSessionSwitch self-check.
 * Run: npm run test:workflow-session-switch
 */
import assert from "node:assert/strict";

import {
  renderWorkflowSwitchContext,
  resolveWorkflowSwitch,
} from "../src/agent/WorkflowSessionSwitch.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("resolveWorkflowSwitch returns undefined for first session turn", () => {
  const result = resolveWorkflowSwitch({
    previous: undefined,
    current: { intent: "answer", workflowType: "answerWorkflow" },
  });
  assert.equal(result, undefined);
});

test("resolveWorkflowSwitch returns undefined when workflow unchanged", () => {
  const result = resolveWorkflowSwitch({
    previous: {
      sessionId: "s1",
      intent: "edit",
      workflowType: "editWorkflow",
      updatedAt: new Date().toISOString(),
    },
    current: { intent: "edit", workflowType: "editWorkflow" },
  });
  assert.equal(result, undefined);
});

test("resolveWorkflowSwitch detects answer to edit transition", () => {
  const result = resolveWorkflowSwitch({
    previous: {
      sessionId: "s1",
      intent: "answer",
      workflowType: "answerWorkflow",
      workflowTaskState: "completed",
      updatedAt: new Date().toISOString(),
    },
    current: { intent: "edit", workflowType: "editWorkflow" },
  });
  assert.ok(result);
  assert.equal(result.switched, true);
  assert.equal(result.fromIntent, "answer");
  assert.equal(result.toIntent, "edit");
  assert.equal(result.fromWorkflowType, "answerWorkflow");
  assert.equal(result.toWorkflowType, "editWorkflow");
  assert.equal(result.fromTaskState, "completed");
});

test("renderWorkflowSwitchContext mentions previous and current workflow", () => {
  const text = renderWorkflowSwitchContext({
    switched: true,
    fromIntent: "plan",
    toIntent: "edit",
    fromWorkflowType: "planWorkflow",
    toWorkflowType: "editWorkflow",
    sequence: 1,
  });
  assert.match(text, /Workflow switched within session/);
  assert.match(text, /planWorkflow \(plan\)/);
  assert.match(text, /editWorkflow \(edit\)/);
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
console.log(`\nworkflow-session-switch: ${tests.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
