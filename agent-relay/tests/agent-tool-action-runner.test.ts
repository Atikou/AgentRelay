/**
 * AgentToolActionRunner 单元测试。
 * 运行：npm run test:agent-tool-action-runner
 */
import assert from "node:assert/strict";

import type { ToolAction } from "../src/agent/AgentActionParser.js";
import { BudgetManager } from "../src/agent/BudgetManager.js";
import { FailedActionMemory } from "../src/agent/recovery/FailedActionMemory.js";
import { RunToolResultCache } from "../src/agent/recovery/RunToolResultCache.js";
import { runAgentToolAction, type AgentToolActionRunContext } from "../src/agent/AgentToolActionRunner.js";
import { buildPathBlockedToolStep } from "../src/agent/AgentToolStepBlockBuilder.js";
import { resolveRunPolicy } from "../src/agent/RunPolicy.js";
import { MODE_BASE_BUDGETS, MODE_SUGGESTED_BUDGETS } from "../src/agent/runBudgetDefaults.js";
import { ToolExecutionGateway } from "../src/agent/ToolExecutionGateway.js";
import { createDefaultRegistry, createMockRegistry, createMockTool } from "../src/tools/index.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

function baseContext(
  registry = createDefaultRegistry(),
  overrides: Partial<AgentToolActionRunContext> = {},
): AgentToolActionRunContext {
  const policy = resolveRunPolicy({
    requestedMode: "implement",
    forceMode: true,
    message: "修改",
    requestedPermissionPolicy: "autoEdit",
  });
  return {
    registry,
    toolGateway: new ToolExecutionGateway(registry),
    workspaceRoot: process.cwd(),
    allowedPermissions: policy.allowedPermissions,
    permissionPolicy: policy.permissionPolicy,
    policyWorkflowType: policy.workflowType,
    getIntent: () => policy.intent,
    isToolExposed: () => true,
    preparePathAccess: () => undefined,
    resolveScopedGrants: () => undefined,
    failedActionMemory: new FailedActionMemory(),
    toolResultCache: new RunToolResultCache(),
    budgetManager: new BudgetManager(MODE_BASE_BUDGETS.implement, MODE_SUGGESTED_BUDGETS.implement),
    buildPathBlockedStep: (action, iteration, pathAccess, toolCallId) =>
      buildPathBlockedToolStep({
        action,
        iteration,
        toolCallId,
        toolPermission: registry.get(action.tool)?.permission,
        pathAccess,
        intent: policy.intent,
        permissionPolicy: policy.permissionPolicy,
      }),
    workflowWriteOrchestration: () => ({}),
    ...overrides,
  };
}

test("未知工具返回 error step", async () => {
  const action: ToolAction = { action: "tool", tool: "not_a_real_tool", input: {} };
  const result = await runAgentToolAction(baseContext(), {
    action,
    iteration: 1,
    toolCallId: "tc-1",
    steps: [],
    goal: "test",
  });
  assert.match(result.step.error ?? "", /未知工具/);
});

test("缓存命中不调用 registry", async () => {
  let invoked = false;
  const readMock = createMockTool({
    name: "read_file",
    permission: "read",
    run: async () => {
      invoked = true;
      return { content: "fresh" };
    },
  });
  const registry = createMockRegistry([readMock]);
  const cache = new RunToolResultCache();
  cache.store("read_file", { path: "a.txt" }, { content: "cached" });
  const action: ToolAction = { action: "tool", tool: "read_file", input: { path: "a.txt" } };
  const result = await runAgentToolAction(
    baseContext(registry, { toolResultCache: cache }),
    { action, iteration: 1, toolCallId: "tc-2", steps: [], goal: "test" },
  );
  assert.equal(invoked, false);
  assert.equal(result.step.cached, true);
  assert.equal(result.step.ok, true);
});

test("dispatch_subagent 收敛门控阻止继续派发", async () => {
  const registry = createDefaultRegistry();
  const action: ToolAction = {
    action: "tool",
    tool: "dispatch_subagent",
    input: { tasks: [{ prompt: "x" }] },
  };
  const priorSteps = Array.from({ length: 3 }, (_, i) => ({
    iteration: i + 1,
    tool: "dispatch_subagent",
    input: {},
    ok: true,
    outcomeClass: "observation_success" as const,
  }));
  const result = await runAgentToolAction(baseContext(registry), {
    action,
    iteration: 4,
    toolCallId: "tc-3",
    steps: priorSteps,
    goal: "test",
  });
  assert.equal(result.step.blocked, true);
  assert.match(result.step.error ?? "", /不要继续派生子 Agent/);
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
console.log(`\nagent-tool-action-runner: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
