/**
 * AgentRunFinalizer 单元测试。
 * 运行：npm run test:agent-run-finalizer
 */
import assert from "node:assert/strict";

import { buildAgentExecutionMeta } from "../src/agent/AgentExecutionMetaBuilder.js";
import { BudgetManager } from "../src/agent/BudgetManager.js";
import { finalizeAgentRun } from "../src/agent/AgentRunFinalizer.js";
import { defaultFinalizer } from "../src/agent/Finalizer.js";
import { resolveRunPolicy } from "../src/agent/RunPolicy.js";
import { MODE_BASE_BUDGETS, MODE_SUGGESTED_BUDGETS } from "../src/agent/runBudgetDefaults.js";
import type { AgentToolStep } from "../src/agent/toolStep.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

function baseContext(overrides: Partial<Parameters<typeof finalizeAgentRun>[0]> = {}) {
  const policy = resolveRunPolicy({
    requestedMode: "implement",
    forceMode: true,
    message: "修改文件",
  });
  const budgetManager = new BudgetManager(MODE_BASE_BUDGETS.implement, MODE_SUGGESTED_BUDGETS.implement);
  return {
    isResume: false,
    policy,
    getEffectiveIntent: () => policy.intent,
    capabilityEscalations: [],
    budgetManager,
    budget: policy.budget,
    workspaceRoot: process.cwd(),
    buildExecutionMeta: (input: Parameters<typeof buildAgentExecutionMeta>[0]) =>
      buildAgentExecutionMeta({
        ...input,
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
      }),
    writeRunUsageSummary: () => {},
    ...overrides,
  };
}

test("completed run 返回 executionMeta 与 stopReason", async () => {
  const result = await finalizeAgentRun(baseContext(), {
    answer: "完成",
    steps: [],
    iterations: 1,
    reachedLimit: false,
    consumedNotifications: [],
    userMessage: "修改文件",
  });
  assert.equal(result.executionMeta.stopReason, "completed");
  assert.equal(result.answer, "完成");
});

test("awaiting_permission 映射 userFacingState", async () => {
  const result = await finalizeAgentRun(baseContext(), {
    answer: "",
    steps: [],
    iterations: 1,
    reachedLimit: false,
    consumedNotifications: [],
    userMessage: "写文件",
    stopReason: "awaiting_permission",
    awaitingPermission: true,
  });
  assert.equal(result.executionMeta.userFacingState, "waiting_tool_permission");
  assert.equal(result.awaitingPermission, true);
});

test("写入 agent_step_plan trace", async () => {
  const events: string[] = [];
  const steps: AgentToolStep[] = [
    { iteration: 1, tool: "read_file", input: { path: "a.ts" }, permission: "read", ok: true },
  ];
  await finalizeAgentRun(
    baseContext({
      runId: "run-trace",
      trace: {
        write: (event) => {
          events.push(String((event as { type?: string }).type));
        },
      } as never,
    }),
    {
      answer: "ok",
      steps,
      iterations: 1,
      reachedLimit: false,
      consumedNotifications: [],
      userMessage: "读文件",
    },
  );
  assert.ok(events.includes("agent_step_plan"));
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed++;
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${t.name}`);
    console.error(err);
  }
}
console.log(`\nagent-run-finalizer: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
