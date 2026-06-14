/**
 * ImplicitPlanWorkflow + WorkflowTaskState self-check.
 * Run: npm run test:implicit-plan-workflow
 */
import assert from "node:assert/strict";

import {
  ImplicitPlanWorkflow,
  assessTaskComplexity,
  shouldRunImplicitPlan,
} from "../src/agent/ImplicitPlanWorkflow.js";
import { resolveWorkflowTaskState } from "../src/agent/WorkflowTaskState.js";
import type { AgentToolStep } from "../src/agent/toolStep.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("assessTaskComplexity detects multi-step goals", () => {
  const result = assessTaskComplexity("修改 AgentLoop 并补充测试，然后验证 typecheck 是否通过");
  assert.equal(result.complex, true);
  assert.ok(result.signals.includes("multi_action"));
});

test("ImplicitPlanWorkflow injects internal checklist for complex edit", () => {
  const result = new ImplicitPlanWorkflow().run({
    goal: "修改 AgentLoop 并补充测试，然后验证 typecheck 是否通过",
    intent: "edit",
    workflowType: "editWorkflow",
    permissionPolicy: "autoEdit",
  });
  assert.ok(result);
  assert.equal(result.plan.phase, "implicit");
  assert.equal(result.plan.userVisiblePlanMode, false);
  assert.ok(result.plan.requiredFields.includes("internalSteps"));
  assert.match(result.modelContext, /NOT user-visible plan mode/);
});

test("skips implicit plan for simple answer intent", () => {
  assert.equal(shouldRunImplicitPlan("answer", "项目名是什么"), false);
  assert.equal(
    new ImplicitPlanWorkflow().run({
      goal: "项目名是什么",
      intent: "answer",
      workflowType: "answerWorkflow",
      permissionPolicy: "readOnly",
    }),
    undefined,
  );
});

test("supports complex verify intent goals", () => {
  const goal = "修改 AgentLoop 并补充测试，然后验证 typecheck 是否通过";
  assert.equal(shouldRunImplicitPlan("verify", goal), true);
  const result = new ImplicitPlanWorkflow().run({
    goal,
    intent: "verify",
    workflowType: "verifyWorkflow",
    permissionPolicy: "autoRun",
  });
  assert.ok(result);
});

test("resolveWorkflowTaskState maps confirmation and completion", () => {
  const blockedStep: AgentToolStep = {
    iteration: 1,
    tool: "write_file",
    input: {},
    permission: "write",
    ok: false,
    blocked: true,
    confirmationRequest: {
      status: "waiting_confirmation",
      title: "write",
      message: "confirm",
      tool: "write_file",
      action: "write_file",
    },
  };
  assert.equal(
    resolveWorkflowTaskState({
      stopReason: "budget_exhausted",
      steps: [blockedStep],
      hasPlanningPhase: true,
    }),
    "waiting_confirmation",
  );
  assert.equal(
    resolveWorkflowTaskState({
      stopReason: "completed",
      steps: [],
      hasPlanningPhase: false,
    }),
    "completed",
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
  console.log(`\nimplicit-plan-workflow: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
