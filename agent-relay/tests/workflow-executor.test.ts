/**
 * WorkflowExecutor self-check.
 * Run: node .\node_modules\tsx\dist\cli.mjs tests\workflow-executor.test.ts
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { resolveRunPolicy } from "../src/agent/RunPolicy.js";
import { defaultRunPolicyManager } from "../src/agent/RunPolicy.js";
import { WorkflowExecutor } from "../src/agent/WorkflowExecutor.js";
import { createDefaultRegistry, createMockRegistry, createMockTool } from "../src/tools/index.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

let sandbox = "";

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
  const policy = resolveRunPolicy({
    requestedMode: "plan",
    message: "请进入计划模式，只读分析当前项目架构并生成计划",
  });
  const executor = new WorkflowExecutor({
    registry: createMockRegistry([projectScan, locate, contextPack]),
    workspaceRoot: sandbox,
    allowedPermissions: policy.allowedPermissions,
    budget: policy.budget,
    budgetManager: defaultRunPolicyManager.createBudgetManager(policy),
    policy,
  });

  const result = await executor.executeBeforeModel({
    goal: "请进入计划模式，只读分析当前项目架构并生成计划",
  });

  assert.deepEqual(result.steps.map((step) => step.tool), [
    "project_scan",
    "locate_relevant_files",
    "context_pack",
  ]);
  assert.equal(result.modelContexts.length, 1);
  assert.match(result.modelContexts[0]!, /内部预扫描/);
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
  const policy = resolveRunPolicy({
    message: "修改 src/agent/AgentLoop.ts 的提示文案",
    requestedPermissionPolicy: "autoEdit",
  });
  const executor = new WorkflowExecutor({
    registry: createMockRegistry([locate, contextPack]),
    workspaceRoot: sandbox,
    allowedPermissions: policy.allowedPermissions,
    budget: policy.budget,
    budgetManager: defaultRunPolicyManager.createBudgetManager(policy),
    policy,
  });

  const result = await executor.executeBeforeModel({
    goal: "修改 src/agent/AgentLoop.ts 的提示文案",
  });

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
  const policy = resolveRunPolicy({
    message: "生成文件 src/agent/NewWorkflow.ts",
    requestedPermissionPolicy: "autoEdit",
  });
  const executor = new WorkflowExecutor({
    registry: createMockRegistry([locate, contextPack]),
    workspaceRoot: sandbox,
    allowedPermissions: policy.allowedPermissions,
    budget: policy.budget,
    budgetManager: defaultRunPolicyManager.createBudgetManager(policy),
    policy,
  });

  const result = await executor.executeBeforeModel({
    goal: "生成文件 src/agent/NewWorkflow.ts",
  });

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
  assert.ok(result.workflowProposals[0]!.requiredFields.includes("targetFiles"));
  assert.equal(locate.calls.length, 1);
  assert.equal(contextPack.calls.length, 1);
});

test("verify workflow is dispatched through WorkflowExecutor", async () => {
  const policy = resolveRunPolicy({
    message: "运行 node --version 验证环境",
    requestedPermissionPolicy: "autoRun",
    budget: {
      maxModelTurns: 1,
      maxToolCalls: 1,
      maxReadCalls: 0,
      maxWriteCalls: 0,
      maxShellCalls: 1,
      maxRuntimeMs: 60000,
    },
  });
  const executor = new WorkflowExecutor({
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
    allowedPermissions: policy.allowedPermissions,
    budget: policy.budget,
    budgetManager: defaultRunPolicyManager.createBudgetManager(policy),
    policy,
  });

  const result = await executor.executeBeforeModel({
    goal: "运行 node --version 验证环境",
  });

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
