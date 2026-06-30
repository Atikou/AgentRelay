/**
 * AgentToolStepPipeline 单元测试。
 * 运行：npm run test:agent-tool-step-pipeline
 */
import assert from "node:assert/strict";

import type { ToolAction } from "../src/agent/AgentActionParser.js";
import { BudgetManager } from "../src/agent/BudgetManager.js";
import { buildEffectiveWorkflowContext } from "../src/agent/EffectiveWorkflowContext.js";
import { executeAgentToolStepPipeline } from "../src/agent/AgentToolStepPipeline.js";
import { resolveRunPolicy } from "../src/agent/RunPolicy.js";
import { MODE_BASE_BUDGETS, MODE_SUGGESTED_BUDGETS } from "../src/agent/runBudgetDefaults.js";
import { defaultWorkflowRouter } from "../src/agent/WorkflowRouter.js";
import { createDefaultRegistry } from "../src/tools/index.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

const writeAction: ToolAction = {
  action: "tool",
  tool: "write_file",
  input: { path: "x.txt", content: "y" },
};

function baseContext(overrides: Partial<Parameters<typeof executeAgentToolStepPipeline>[0]> = {}) {
  const policy = resolveRunPolicy({
    requestedMode: "plan",
    forceMode: true,
    message: "制定计划",
  });
  const planRoute = defaultWorkflowRouter.routeIntent("plan");
  const budgetManager = new BudgetManager(policy.budget, policy.suggestedBudget);
  return {
    registry: createDefaultRegistry(),
    mode: policy.mode,
    permissionPolicy: policy.permissionPolicy,
    allowedPermissions: policy.allowedPermissions,
    getIntent: () => policy.intent,
    getWorkflowContext: () =>
      buildEffectiveWorkflowContext({
        entryIntent: policy.intent,
        entryWorkflowType: planRoute.workflowType,
        capabilityEscalations: [],
      }),
    capabilityEscalations: [],
    budgetManager,
    pauseOnPermissionRequest: true,
    resolveScopedGrants: () => undefined,
    preparePathAccess: () => undefined,
    runToolAction: async () => {
      throw new Error("runToolAction should not be called");
    },
    ...overrides,
  };
}

test("plan 模式写工具被 workflow 层阻断", async () => {
  const result = await executeAgentToolStepPipeline(baseContext(), {
    action: writeAction,
    iteration: 1,
    toolCallId: "tc-1",
    steps: [],
    goal: "写计划",
    messages: [],
  });
  assert.equal(result.kind, "step");
  if (result.kind !== "step") return;
  assert.equal(result.step.blockedReasonKind, "workflow");
  assert.equal(result.step.blocked, true);
});

test("confirmBeforeEdit 下写工具返回 permission 阻断", async () => {
  const implementPolicy = resolveRunPolicy({
    requestedMode: "implement",
    forceMode: true,
    message: "修改文件",
    requestedPermissionPolicy: "confirmBeforeEdit",
  });
  const editRoute = defaultWorkflowRouter.routeIntent("edit");
  const result = await executeAgentToolStepPipeline(
    baseContext({
      mode: implementPolicy.mode,
      permissionPolicy: implementPolicy.permissionPolicy,
      allowedPermissions: implementPolicy.allowedPermissions,
      getIntent: () => implementPolicy.intent,
      getWorkflowContext: () =>
        buildEffectiveWorkflowContext({
          entryIntent: implementPolicy.intent,
          entryWorkflowType: editRoute.workflowType,
          capabilityEscalations: [],
        }),
      runToolAction: async () => ({
        iteration: 1,
        tool: "write_file",
        input: writeAction.input ?? {},
        permission: "write",
        blocked: true,
        confirmationRequest: {
          status: "waiting_confirmation",
          title: "写入确认",
          message: "需要写入",
          tool: "write_file",
          permission: "write",
          intent: "edit",
          permissionPolicy: "confirmBeforeEdit",
          action: "write",
          affects: { files: ["x.txt"], commands: [], networkTargets: [] },
          risk: {
            tier: "medium",
            category: "file_write",
            summary: "写文件",
            reasons: [],
          },
        },
      }),
    }),
    {
      action: writeAction,
      iteration: 1,
      toolCallId: "tc-2",
      steps: [],
      goal: "写文件",
      messages: [],
    },
  );
  assert.equal(result.kind, "pause");
});

test("分项预算耗尽返回 budget", async () => {
  const implementPolicy = resolveRunPolicy({
    requestedMode: "implement",
    forceMode: true,
    message: "修改",
    requestedPermissionPolicy: "autoEdit",
  });
  const editRoute = defaultWorkflowRouter.routeIntent("edit");
  const budgetManager = new BudgetManager(
    { ...MODE_BASE_BUDGETS.implement, maxWriteCalls: 1 },
    MODE_SUGGESTED_BUDGETS.implement,
  );
  const priorWriteStep = {
    iteration: 1,
    tool: "write_file",
    input: { path: "a.txt", content: "a" },
    permission: "write" as const,
    ok: true,
  };
  const result = await executeAgentToolStepPipeline(
    baseContext({
      mode: implementPolicy.mode,
      permissionPolicy: implementPolicy.permissionPolicy,
      allowedPermissions: implementPolicy.allowedPermissions,
      getIntent: () => implementPolicy.intent,
      getWorkflowContext: () =>
        buildEffectiveWorkflowContext({
          entryIntent: implementPolicy.intent,
          entryWorkflowType: editRoute.workflowType,
          capabilityEscalations: [],
        }),
      budgetManager,
    }),
    {
      action: writeAction,
      iteration: 2,
      toolCallId: "tc-3",
      steps: [priorWriteStep],
      goal: "写",
      messages: [],
    },
  );
  assert.equal(result.kind, "budget");
  if (result.kind !== "budget") return;
  assert.equal(result.budgetExhausted, "maxWriteCalls");
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
console.log(`\nagent-tool-step-pipeline: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
