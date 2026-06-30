/**
 * AgentExecutionMetaBuilder 单元测试。
 * 运行：npm run test:agent-execution-meta-builder
 */
import assert from "node:assert/strict";

import { buildAgentExecutionMeta } from "../src/agent/AgentExecutionMetaBuilder.js";
import { BudgetManager } from "../src/agent/BudgetManager.js";
import { defaultFinalizer } from "../src/agent/Finalizer.js";
import { defaultRunPolicyManager } from "../src/agent/RunPolicy.js";
import { MODE_BASE_BUDGETS, MODE_SUGGESTED_BUDGETS } from "../src/agent/runBudgetDefaults.js";
import type { AgentToolStep } from "../src/agent/toolStep.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

function baseInput(overrides: Partial<Parameters<typeof buildAgentExecutionMeta>[0]> = {}) {
  const policy = defaultRunPolicyManager.resolve({
    requestedMode: "implement",
    forceMode: true,
    message: "修改文件",
  });
  const budgetManager = new BudgetManager(MODE_BASE_BUDGETS.implement, MODE_SUGGESTED_BUDGETS.implement);
  return {
    steps: [] as AgentToolStep[],
    iterations: 1,
    stopReason: "completed" as const,
    goal: "修改文件",
    policy,
    effectiveIntent: policy.intent,
    budget: policy.budget,
    budgetManager,
    finalizer: defaultFinalizer,
    workflowProposals: [],
    workflowDebugAnalyses: [],
    workflowRefactorPlans: [],
    workflowInternalPlans: [],
    workflowWritePhases: [],
    workflowDebugFixes: [],
    capabilityEscalations: [],
    ...overrides,
  };
}

test("completed run 填充 userFacingLabel 与 usage", () => {
  const meta = buildAgentExecutionMeta(baseInput());
  assert.equal(meta.stopReason, "completed");
  assert.ok(meta.userFacingLabel);
  assert.equal(meta.usedModelTurns, 1);
  assert.equal(meta.intent, "edit");
});

test("awaiting_permission 映射为等待工具授权", () => {
  const meta = buildAgentExecutionMeta(
    baseInput({ stopReason: "awaiting_permission" }),
  );
  assert.equal(meta.userFacingState, "waiting_tool_permission");
  assert.match(meta.userFacingLabel ?? "", /授权/);
});

test("budget_exhausted 时 enrich suggestedBudget 与 missingSteps", () => {
  const steps: AgentToolStep[] = [
    {
      iteration: 1,
      tool: "read_file",
      input: { path: "a.ts" },
      permission: "read",
      ok: true,
    },
  ];
  const meta = buildAgentExecutionMeta(
    baseInput({
      steps,
      stopReason: "budget_exhausted",
      budgetExhausted: "maxToolCalls",
      iterations: 2,
    }),
  );
  assert.equal(meta.needsMoreBudget, true);
  assert.ok(meta.suggestedBudget);
  assert.ok(meta.missingSteps?.length);
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    passed++;
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${t.name}`);
    console.error(err);
  }
}
console.log(`\nagent-execution-meta-builder: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
