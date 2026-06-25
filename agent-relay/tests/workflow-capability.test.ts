/**
 * WorkflowCapability + CapabilityEscalation 自检。
 * 运行：npm run test:workflow-capability
 */
import assert from "node:assert/strict";

import {
  evaluateCapabilityEscalation,
  resolveEscalationTarget,
} from "../src/agent/CapabilityEscalation.js";
import {
  assessWorkflowToolAccess,
  resolveAllowedPermissions,
} from "../src/agent/WorkflowCapability.js";
import { augmentContractWithEscalations } from "../src/agent/capabilityEscalationRuntime.js";
import { SessionTaskManager } from "../src/agent/task/SessionTaskManager.js";
import { BudgetManager } from "../src/agent/BudgetManager.js";
import { resolveRunPolicy } from "../src/agent/RunPolicy.js";
import { defaultWorkflowRouter } from "../src/agent/WorkflowRouter.js";
import { workflowSatisfiesSideEffects } from "../src/agent/routing/TaskBoundaryDecision.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("review + autoRun 仅允许 read（hard workflow）", () => {
  const route = defaultWorkflowRouter.routeIntent("review");
  assert.deepEqual(resolveAllowedPermissions(route, "autoRun"), ["read"]);
});

test("review 模式 shell → readonly_mode_blocked", () => {
  const block = assessWorkflowToolAccess({
    mode: "review",
    workflowRoute: defaultWorkflowRouter.routeIntent("review"),
    toolPermission: "shell",
  });
  assert.equal(block.blocked, true);
  assert.equal(block.outcomeKind, "readonly_mode_blocked");
});

test("review 模式 write → readonly_mode_blocked", () => {
  const block = assessWorkflowToolAccess({
    mode: "review",
    workflowRoute: defaultWorkflowRouter.routeIntent("review"),
    toolPermission: "write",
  });
  assert.equal(block.blocked, true);
  assert.equal(block.outcomeKind, "readonly_mode_blocked");
});

test("planWorkflow + shell → hard blocked", () => {
  const block = assessWorkflowToolAccess({
    mode: "plan",
    workflowRoute: defaultWorkflowRouter.routeIntent("plan"),
    toolPermission: "shell",
  });
  assert.equal(block.blocked, true);
});

test("runWorkflow + autoRun 允许 write（soft workflow 不压制用户策略）", () => {
  const route = defaultWorkflowRouter.routeIntent("run");
  const allowed = resolveAllowedPermissions(route, "autoRun");
  assert.ok(allowed.includes("write"));
  assert.ok(allowed.includes("shell"));
});

test("runWorkflow + write_file → soft 不 workflow_capability_denied", () => {
  const route = defaultWorkflowRouter.routeIntent("run");
  const block = assessWorkflowToolAccess({
    mode: "debug",
    workflowRoute: route,
    toolPermission: "write",
  });
  assert.equal(block.blocked, false);
});

test("runWorkflow + write 触发 capability escalation", () => {
  const route = defaultWorkflowRouter.routeIntent("run");
  const escalation = evaluateCapabilityEscalation({
    workflowRoute: route,
    toolName: "write_file",
    toolPermission: "write",
  });
  assert.ok(escalation);
  assert.equal(escalation!.canEscalate, true);
  assert.equal(escalation!.fromWorkflow, "runWorkflow");
  assert.equal(escalation!.toWorkflow, "debugWorkflow");
});

test("editWorkflow + shell 可 escalation 到 debug/mixed", () => {
  const route = defaultWorkflowRouter.routeIntent("edit");
  const target = resolveEscalationTarget(route, "shell");
  assert.equal(target.workflowType, "debugWorkflow");
  const block = assessWorkflowToolAccess({
    mode: "implement",
    workflowRoute: route,
    toolPermission: "shell",
  });
  assert.equal(block.blocked, false);
});

test("runWorkflow 续写需要 write 时不打断 task continuation", () => {
  assert.equal(workflowSatisfiesSideEffects("runWorkflow", ["write"]), true);
});

test("reviewWorkflow 续写需要 write 时仍不兼容", () => {
  assert.equal(workflowSatisfiesSideEffects("reviewWorkflow", ["write"]), false);
});

test("BudgetManager 在 review 零 shell 配额下不判耗尽（由 workflow 拦截）", () => {
  const policy = resolveRunPolicy({
    requestedMode: "review",
    forceMode: true,
    message: "x",
  });
  const mgr = new BudgetManager(policy.budget, policy.suggestedBudget);
  assert.equal(
    mgr.findToolExhaustion({ toolPermission: "shell", permissionAllowed: true, steps: [] }),
    undefined,
  );
});

test("implement 模式 shell 第三次才真正 budget_exhausted", () => {
  const policy = resolveRunPolicy({
    requestedMode: "implement",
    forceMode: true,
    budget: { maxShellCalls: 2 },
    message: "x",
  });
  const mgr = new BudgetManager(policy.budget, policy.suggestedBudget);
  const shellStep = (n: number) => ({
    iteration: n,
    tool: "shell_run",
    input: {},
    permission: "shell" as const,
    ok: true,
    executed: true,
    outcomeClass: "observation_success" as const,
  });
  assert.equal(
    mgr.findToolExhaustion({ toolPermission: "shell", permissionAllowed: true, steps: [shellStep(1)] }),
    undefined,
  );
  assert.equal(
    mgr.findToolExhaustion({
      toolPermission: "shell",
      permissionAllowed: true,
      steps: [shellStep(1), shellStep(2)],
    }),
    "maxShellCalls",
  );
});

test("escalation 后 completion contract 包含 write", () => {
  const augmented = augmentContractWithEscalations(
    { requiresSideEffect: true, requiredSideEffects: ["shell"] },
    [
      {
        fromWorkflow: "runWorkflow",
        fromIntent: "run",
        toWorkflow: "debugWorkflow",
        toIntent: "debug",
        requestedTool: "write_file",
        requestedPermission: "write",
        currentExpectedSideEffects: ["read", "shell"],
        targetSideEffects: ["read", "shell", "write"],
        canEscalate: true,
        reason: "test",
        iteration: 4,
        applied: true,
      },
    ],
  );
  assert.ok(augmented.requiredSideEffects.includes("write"));
  assert.ok(augmented.requiredSideEffects.includes("shell"));
});

test("SessionTaskManager 持久化 reconciled workflow 供续写", () => {
  const mgr = new SessionTaskManager();
  mgr.updateFromRun({
    sessionId: "s-escalation",
    goal: "把星云做得更震撼",
    intent: "run",
    workflowType: "runWorkflow",
    reconciledIntent: "debug",
    reconciledWorkflowType: "debugWorkflow",
    stopReason: "completed",
  });
  const ctx = mgr.getContext("s-escalation");
  assert.equal(ctx?.intent, "debug");
  assert.equal(ctx?.workflowType, "debugWorkflow");
  assert.equal(ctx?.entryIntent, "run");
  assert.equal(ctx?.entryWorkflowType, "runWorkflow");
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
console.log(`\nworkflow-capability: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
