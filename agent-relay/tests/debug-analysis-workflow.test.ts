/**
 * DebugAnalysisWorkflow self-check.
 * Run: node .\node_modules\tsx\dist\cli.mjs tests\debug-analysis-workflow.test.ts
 */
import assert from "node:assert/strict";

import { DebugAnalysisWorkflow } from "../src/agent/DebugAnalysisWorkflow.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("debug intent produces analysis context and audit record", () => {
  const result = new DebugAnalysisWorkflow().run({
    goal: "修复 src/agent/AgentLoop.ts 中未知工具 PlanWorkflow 的错误",
    intent: "debug",
    permissionPolicy: "autoEdit",
  });

  assert.ok(result);
  assert.match(result!.modelContext, /debugWorkflow analysis phase/);
  assert.match(result!.modelContext, /rootCauseHypotheses/);
  assert.match(result!.modelContext, /minimalFixPlan/);
  assert.equal(result!.analysis.workflowType, "debugWorkflow");
  assert.equal(result!.analysis.phase, "analysis");
  assert.equal(result!.analysis.intent, "debug");
  assert.equal(result!.analysis.writeAllowedByPolicy, true);
  assert.equal(result!.analysis.requiresConfirmationBeforeWrite, false);
  assert.ok(result!.analysis.requiredFields.includes("verificationPlan"));
  assert.ok(result!.analysis.suggestedTools.includes("context_pack"));
});

test("non-debug intent does not inject debug analysis", () => {
  const result = new DebugAnalysisWorkflow().run({
    goal: "修改 src/agent/AgentLoop.ts",
    intent: "edit",
    permissionPolicy: "autoEdit",
  });

  assert.equal(result, undefined);
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
console.log(`\ndebug-analysis-workflow: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
