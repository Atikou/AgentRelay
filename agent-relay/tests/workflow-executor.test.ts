/**
 * WorkflowExecutor self-check.
 * Run: node .\node_modules\tsx\dist\cli.mjs tests\workflow-executor.test.ts
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { shouldRunImplicitPlan } from "../src/agent/ImplicitPlanWorkflow.js";
import { resolveRunPolicy, defaultRunPolicyManager } from "../src/agent/RunPolicy.js";
import type { RunPolicy } from "../src/agent/RunPolicyTypes.js";
import { WorkflowExecutor } from "../src/agent/WorkflowExecutor.js";
import type { ToolPermission } from "../src/core/permissions.js";
import { createDefaultRegistry, createMockRegistry, createMockTool } from "../src/tools/index.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

let sandbox = "";

const readOnlyPermissions: ToolPermission[] = ["read"];
const editPermissions: ToolPermission[] = ["read", "write"];
const runPermissions: ToolPermission[] = ["read", "write", "shell", "network", "dangerous"];

function policyWith(
  input: Parameters<typeof resolveRunPolicy>[0],
  patch: Partial<RunPolicy>,
): RunPolicy {
  return { ...resolveRunPolicy(input), ...patch };
}

test("plan workflow is dispatched through WorkflowExecutor", async () => {
  const projectScan = createMockTool({
    name: "project_scan",
    permission: "read",
    output: { sourceRoots: ["src"], importantFiles: ["package.json"] },
  });
  const locate = createMockTool({
    name: "locate_relevant_files",
    permission: "read",
    output: {
      primaryFiles: [{ path: "src/agent/AgentLoop.ts", score: 0.9, reason: "target" }],
      candidateFiles: [],
      locateStats: {},
    },
  });
  const contextPack = createMockTool({
    name: "context_pack",
    permission: "read",
    output: { files: [{ path: "src/agent/AgentLoop.ts", content: "export class AgentLoop {}" }] },
  });
  const policy = policyWith(
    { requestedMode: "plan", message: "analyze codebase architecture plan" },
    {
      mode: "plan",
      intent: "plan",
      workflowType: "planWorkflow",
      allowedPermissions: readOnlyPermissions,
    },
  );
  const executor = new WorkflowExecutor({
    registry: createMockRegistry([projectScan, locate, contextPack]),
    workspaceRoot: sandbox,
    allowedPermissions: policy.allowedPermissions,
    budget: policy.budget,
    budgetManager: defaultRunPolicyManager.createBudgetManager(policy),
    policy,
  });

  const result = await executor.executeBeforeModel({ goal: "analyze codebase architecture plan" });

  assert.deepEqual(result.steps.map((step) => step.tool), [
    "project_scan",
    "locate_relevant_files",
    "context_pack",
  ]);
  assert.equal(result.modelContexts.length, 1);
  assert.match(result.modelContexts[0]!, /预扫描结果/);
  assert.equal(projectScan.calls.length, 1);
  assert.equal(locate.calls.length, 1);
  assert.equal(contextPack.calls.length, 1);
});

test("edit workflow prelocates files through WorkflowExecutor", async () => {
  const locate = createMockTool({
    name: "locate_relevant_files",
    permission: "read",
    output: {
      primaryFiles: [{ path: "src/agent/AgentLoop.ts", score: 0.9, reason: "target" }],
      candidateFiles: [],
      locateStats: {},
    },
  });
  const contextPack = createMockTool({
    name: "context_pack",
    permission: "read",
    output: { files: [{ path: "src/agent/AgentLoop.ts", content: "export class AgentLoop {}" }] },
  });
  const policy = policyWith(
    { message: "edit src/agent/AgentLoop.ts prompt text", requestedPermissionPolicy: "autoEdit" },
    {
      mode: "implement",
      intent: "edit",
      workflowType: "editWorkflow",
      allowedPermissions: editPermissions,
    },
  );
  const executor = new WorkflowExecutor({
    registry: createMockRegistry([locate, contextPack]),
    workspaceRoot: sandbox,
    allowedPermissions: policy.allowedPermissions,
    budget: policy.budget,
    budgetManager: defaultRunPolicyManager.createBudgetManager(policy),
    policy,
  });

  const result = await executor.executeBeforeModel({ goal: "edit src/agent/AgentLoop.ts prompt text" });

  assert.deepEqual(result.steps.map((step) => step.tool), [
    "locate_relevant_files",
    "context_pack",
  ]);
  assert.equal(result.modelContexts.length, 2);
  assert.match(result.modelContexts[0]!, /editWorkflow read-only prelocation result/);
  assert.match(result.modelContexts[1]!, /editWorkflow proposal phase/);
  assert.match(result.modelContexts[1]!, /diffPlan/);
  assert.equal(result.workflowProposals.length, 1);
  assert.equal(result.workflowProposals[0]!.workflowType, "editWorkflow");
  assert.equal(result.workflowProposals[0]!.permissionPolicy, "autoEdit");
  assert.equal(result.workflowProposals[0]!.writeAllowedByPolicy, true);
  assert.equal(result.workflowProposals[0]!.requiresConfirmationBeforeWrite, false);
  assert.equal(result.workflowProposals[0]!.permissionSummary, "write_allowed");
  assert.equal(result.workflowProposals[0]!.permissionChecks[0]!.toolName, "apply_patch");
  assert.equal(result.workflowProposals[0]!.permissionChecks[0]!.decision, "allow");
  assert.ok(result.workflowProposals[0]!.requiredFields.includes("diffPlan"));
  assert.equal(locate.calls.length, 1);
  assert.equal(contextPack.calls.length, 1);
});

test("generate file workflow prelocates conventions through WorkflowExecutor", async () => {
  const locate = createMockTool({
    name: "locate_relevant_files",
    permission: "read",
    output: {
      primaryFiles: [{ path: "src/agent/WorkflowPlanner.ts", score: 0.88, reason: "nearby" }],
      candidateFiles: [],
      locateStats: {},
    },
  });
  const contextPack = createMockTool({
    name: "context_pack",
    permission: "read",
    output: { files: [{ path: "src/agent/WorkflowPlanner.ts", content: "export class WorkflowPlanner {}" }] },
  });
  const policy = policyWith(
    { message: "generate file src/agent/NewWorkflow.ts", requestedPermissionPolicy: "autoEdit" },
    {
      mode: "implement",
      intent: "generate_file",
      workflowType: "generateFileWorkflow",
      allowedPermissions: editPermissions,
    },
  );
  const executor = new WorkflowExecutor({
    registry: createMockRegistry([locate, contextPack]),
    workspaceRoot: sandbox,
    allowedPermissions: policy.allowedPermissions,
    budget: policy.budget,
    budgetManager: defaultRunPolicyManager.createBudgetManager(policy),
    policy,
  });

  const result = await executor.executeBeforeModel({ goal: "generate file src/agent/NewWorkflow.ts" });

  assert.deepEqual(result.steps.map((step) => step.tool), [
    "locate_relevant_files",
    "context_pack",
  ]);
  assert.equal(result.modelContexts.length, 2);
  assert.match(result.modelContexts[0]!, /generateFileWorkflow read-only prelocation result/);
  assert.match(result.modelContexts[1]!, /generateFileWorkflow proposal phase/);
  assert.match(result.modelContexts[1]!, /targetFiles/);
  assert.equal(result.workflowProposals.length, 1);
  assert.equal(result.workflowProposals[0]!.workflowType, "generateFileWorkflow");
  assert.equal(result.workflowProposals[0]!.intent, "generate_file");
  assert.equal(result.workflowProposals[0]!.permissionSummary, "write_allowed");
  assert.ok(result.workflowProposals[0]!.requiredFields.includes("targetFiles"));
  assert.equal(locate.calls.length, 1);
  assert.equal(contextPack.calls.length, 1);
});

test("debug workflow prelocates and injects analysis phase", async () => {
  const locate = createMockTool({
    name: "locate_relevant_files",
    permission: "read",
    output: {
      primaryFiles: [{ path: "src/agent/AgentLoop.ts", score: 0.9, reason: "error path" }],
      candidateFiles: [],
      locateStats: {},
    },
  });
  const contextPack = createMockTool({
    name: "context_pack",
    permission: "read",
    output: { files: [{ path: "src/agent/AgentLoop.ts", content: "renderToolResult()" }] },
  });
  const policy = policyWith(
    { requestedMode: "debug", message: "debug AgentLoop tool error", requestedPermissionPolicy: "autoEdit" },
    {
      mode: "debug",
      intent: "debug",
      workflowType: "debugWorkflow",
      allowedPermissions: editPermissions,
    },
  );
  const executor = new WorkflowExecutor({
    registry: createMockRegistry([locate, contextPack]),
    workspaceRoot: sandbox,
    allowedPermissions: policy.allowedPermissions,
    budget: policy.budget,
    budgetManager: defaultRunPolicyManager.createBudgetManager(policy),
    policy,
  });

  const result = await executor.executeBeforeModel({ goal: "debug AgentLoop tool error" });

  assert.deepEqual(result.steps.map((step) => step.tool), [
    "locate_relevant_files",
    "context_pack",
  ]);
  assert.equal(result.modelContexts.length, 2);
  assert.match(result.modelContexts[0]!, /debugWorkflow read-only diagnosis context/);
  assert.match(result.modelContexts[1]!, /debugWorkflow analysis phase/);
  assert.match(result.modelContexts[1]!, /rootCauseHypotheses/);
  assert.equal(result.workflowDebugAnalyses.length, 1);
  assert.equal(result.workflowDebugAnalyses[0]!.workflowType, "debugWorkflow");
  assert.equal(result.workflowDebugAnalyses[0]!.phase, "analysis");
  assert.equal(result.workflowDebugAnalyses[0]!.writeAllowedByPolicy, true);
  assert.equal(result.workflowProposals.length, 0);
  assert.equal(locate.calls.length, 1);
  assert.equal(contextPack.calls.length, 1);
});

test("refactor workflow prescan and injects staged plan phase", async () => {
  const projectScan = createMockTool({
    name: "project_scan",
    permission: "read",
    output: { sourceRoots: ["src"], importantFiles: ["package.json"] },
  });
  const locate = createMockTool({
    name: "locate_relevant_files",
    permission: "read",
    output: {
      primaryFiles: [
        { path: "src/model-router/index.ts", score: 0.9, reason: "router" },
        { path: "src/agent/index.ts", score: 0.85, reason: "agent" },
      ],
      candidateFiles: [],
      locateStats: {},
    },
  });
  const contextPack = createMockTool({
    name: "context_pack",
    permission: "read",
    output: {
      files: [
        { path: "src/model-router/index.ts", content: "export * from './smart-model-router.js';" },
      ],
    },
  });
  const policy = policyWith(
    { message: "refactor model-router and agent modules", requestedPermissionPolicy: "autoEdit" },
    {
      mode: "implement",
      intent: "refactor",
      workflowType: "refactorWorkflow",
      allowedPermissions: editPermissions,
    },
  );
  const executor = new WorkflowExecutor({
    registry: createMockRegistry([projectScan, locate, contextPack]),
    workspaceRoot: sandbox,
    allowedPermissions: policy.allowedPermissions,
    budget: policy.budget,
    budgetManager: defaultRunPolicyManager.createBudgetManager(policy),
    policy,
  });

  const result = await executor.executeBeforeModel({ goal: "refactor model-router and agent modules" });

  assert.deepEqual(result.steps.map((step) => step.tool), [
    "project_scan",
    "locate_relevant_files",
    "context_pack",
  ]);
  assert.equal(result.modelContexts.length, 2);
  assert.match(result.modelContexts[0]!, /refactorWorkflow read-only prescan result/);
  assert.match(result.modelContexts[1]!, /refactorWorkflow plan phase/);
  assert.match(result.modelContexts[1]!, /stagedChanges/);
  assert.equal(result.workflowRefactorPlans.length, 1);
  assert.equal(result.workflowRefactorPlans[0]!.workflowType, "refactorWorkflow");
  assert.equal(result.workflowRefactorPlans[0]!.phase, "plan");
  assert.equal(result.workflowProposals.length, 0);
  assert.equal(result.workflowDebugAnalyses.length, 0);
});

test("complex edit workflow injects implicit internal plan", async () => {
  const locate = createMockTool({
    name: "locate_relevant_files",
    permission: "read",
    output: {
      primaryFiles: [{ path: "src/agent/AgentLoop.ts", score: 0.9, reason: "target" }],
      candidateFiles: [],
      locateStats: {},
    },
  });
  const contextPack = createMockTool({
    name: "context_pack",
    permission: "read",
    output: { files: [{ path: "src/agent/AgentLoop.ts", content: "export class AgentLoop {}" }] },
  });
  const goal = "edit AgentLoop, add tests, then verify typecheck";
  const policy = policyWith(
    { message: goal, requestedPermissionPolicy: "autoEdit" },
    {
      mode: "implement",
      intent: "edit",
      workflowType: "editWorkflow",
      allowedPermissions: editPermissions,
    },
  );
  assert.ok(shouldRunImplicitPlan(policy.intent, goal), `intent=${policy.intent}`);
  const executor = new WorkflowExecutor({
    registry: createMockRegistry([locate, contextPack]),
    workspaceRoot: sandbox,
    allowedPermissions: policy.allowedPermissions,
    budget: policy.budget,
    budgetManager: defaultRunPolicyManager.createBudgetManager(policy),
    policy,
  });

  const result = await executor.executeBeforeModel({ goal });

  assert.equal(result.workflowInternalPlans.length, 1);
  assert.equal(result.workflowInternalPlans[0]!.phase, "implicit");
  assert.equal(result.workflowInternalPlans[0]!.userVisiblePlanMode, false);
  assert.match(result.modelContexts.find((ctx) => ctx.includes("implicit internal plan phase")) ?? "", /internalSteps/);
  assert.equal(result.workflowProposals.length, 1);
});

test("edit proposal records confirmation-required permission checks", async () => {
  const locate = createMockTool({
    name: "locate_relevant_files",
    permission: "read",
    output: {
      primaryFiles: [{ path: "src/agent/AgentLoop.ts", score: 0.9, reason: "target" }],
      candidateFiles: [],
      locateStats: {},
    },
  });
  const contextPack = createMockTool({
    name: "context_pack",
    permission: "read",
    output: { files: [{ path: "src/agent/AgentLoop.ts", content: "export class AgentLoop {}" }] },
  });
  const policy = policyWith(
    {
      requestedMode: "implement",
      forceMode: true,
      message: "edit src/agent/AgentLoop.ts prompt text",
      requestedPermissionPolicy: "confirmBeforeEdit",
    },
    {
      mode: "implement",
      intent: "edit",
      workflowType: "editWorkflow",
      allowedPermissions: editPermissions,
    },
  );
  const executor = new WorkflowExecutor({
    registry: createMockRegistry([locate, contextPack]),
    workspaceRoot: sandbox,
    allowedPermissions: policy.allowedPermissions,
    budget: policy.budget,
    budgetManager: defaultRunPolicyManager.createBudgetManager(policy),
    policy,
  });

  const result = await executor.executeBeforeModel({ goal: "edit src/agent/AgentLoop.ts prompt text" });

  assert.equal(result.workflowProposals.length, 1);
  assert.equal(result.workflowProposals[0]!.permissionSummary, "confirmation_required");
  assert.equal(result.workflowProposals[0]!.requiresConfirmationBeforeWrite, true);
  assert.deepEqual(
    result.workflowProposals[0]!.permissionChecks.map((check) => check.decision),
    ["needsConfirmation", "needsConfirmation"],
  );
  assert.match(result.modelContexts.join("\n"), /preflightPermissionChecks/);
});

test("verify workflow is dispatched through WorkflowExecutor", async () => {
  const policy = policyWith(
    {
      message: "run node --version to verify environment",
      requestedPermissionPolicy: "autoRun",
      budget: {
        maxModelTurns: 1,
        maxToolCalls: 1,
        maxReadCalls: 0,
        maxWriteCalls: 0,
        maxShellCalls: 1,
        maxRuntimeMs: 60000,
      },
    },
    {
      mode: "implement",
      intent: "verify",
      workflowType: "verifyWorkflow",
      allowedPermissions: runPermissions,
    },
  );
  const executor = new WorkflowExecutor({
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
    allowedPermissions: policy.allowedPermissions,
    budget: policy.budget,
    budgetManager: defaultRunPolicyManager.createBudgetManager(policy),
    policy,
  });

  const result = await executor.executeBeforeModel({ goal: "run node --version to verify environment" });

  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]!.tool, "shell_run");
  assert.equal(result.steps[0]!.ok, true);
  assert.match(result.modelContexts.join("\n"), /verifyWorkflow automatic verification result/);
});

async function main() {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-executor-"));
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok ${t.name}`);
      passed += 1;
    } catch (error) {
      console.error(`  FAIL ${t.name}`);
      console.error(error);
      failed += 1;
    }
  }
  await fs.rm(sandbox, { recursive: true, force: true });
  console.log(`\nworkflow-executor: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

void main();
