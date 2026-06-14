/**
 * RefactorPlanWorkflow self-check.
 * Run: npm run test:refactor-plan-workflow
 */
import assert from "node:assert/strict";

import {
  REFACTOR_PLAN_MAX_STAGES,
  RefactorPlanWorkflow,
} from "../src/agent/RefactorPlanWorkflow.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("injects staged refactor plan phase", () => {
  const result = new RefactorPlanWorkflow().run({
    goal: "先解耦 model-router 与 agent 模块",
    intent: "refactor",
    permissionPolicy: "confirmBeforeEdit",
  });

  assert.ok(result);
  assert.equal(result.plan.workflowType, "refactorWorkflow");
  assert.equal(result.plan.phase, "plan");
  assert.equal(result.plan.maxStages, REFACTOR_PLAN_MAX_STAGES);
  assert.equal(result.plan.requiresConfirmationBeforeWrite, true);
  assert.ok(result.plan.requiredFields.includes("stagedChanges"));
  assert.ok(result.plan.requiredFields.includes("perStageVerification"));
  assert.match(result.modelContext, /refactorWorkflow plan phase/);
  assert.match(result.modelContext, /Execute only one stage at a time/);
});

test("skips non-refactor intents", () => {
  assert.equal(
    new RefactorPlanWorkflow().run({
      goal: "edit file",
      intent: "edit",
      permissionPolicy: "autoEdit",
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
  console.log(`\nrefactor-plan-workflow: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
