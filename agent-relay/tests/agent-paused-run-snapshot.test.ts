/**
 * AgentPausedRunSnapshot 单元测试。
 * 运行：npm run test:agent-paused-run-snapshot
 */
import assert from "node:assert/strict";

import {
  buildPausedRunRuntimeState,
  buildPausedRunSnapshot,
  createJitPermissionRequestFromStep,
  restorePausedRunRuntimeState,
} from "../src/agent/AgentPausedRunSnapshot.js";
import { BudgetManager } from "../src/agent/BudgetManager.js";
import { MODE_BASE_BUDGETS, MODE_SUGGESTED_BUDGETS } from "../src/agent/runBudgetDefaults.js";
import { FailedActionMemory } from "../src/agent/recovery/FailedActionMemory.js";
import { RunToolResultCache } from "../src/agent/recovery/RunToolResultCache.js";
import type { CapabilityEscalationRecord } from "../src/agent/CapabilityEscalation.js";
import { PermissionRequestStore } from "../src/policy/PermissionRequestStore.js";
import type { AgentToolStep } from "../src/agent/toolStep.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

function runtimeDeps() {
  const budgetManager = new BudgetManager(
    MODE_BASE_BUDGETS.implement,
    MODE_SUGGESTED_BUDGETS.implement,
  );
  budgetManager.recordPreflightTool(2);
  const failedActionMemory = new FailedActionMemory();
  const toolResultCache = new RunToolResultCache();
  toolResultCache.store("read_file", { path: "a.ts" }, "content");
  return { budgetManager, failedActionMemory, toolResultCache };
}

test("buildPausedRunRuntimeState 收集 intent / escalation / 预算 / 缓存", () => {
  const { budgetManager, failedActionMemory, toolResultCache } = runtimeDeps();
  const escalations: CapabilityEscalationRecord[] = [
    {
      fromWorkflow: "runWorkflow",
      fromIntent: "run",
      toWorkflow: "editWorkflow",
      toIntent: "edit",
      requestedTool: "write_file",
      requestedPermission: "write",
      currentExpectedSideEffects: ["read", "shell"],
      targetSideEffects: ["read", "shell", "write"],
      canEscalate: true,
      reason: "write detected",
      iteration: 1,
      applied: true,
    },
  ];
  const state = buildPausedRunRuntimeState({
    entryIntent: "run",
    entryWorkflowType: "runWorkflow",
    reconciledIntent: "edit",
    reconciledWorkflowType: "editWorkflow",
    capabilityEscalations: escalations,
    budgetManager,
    failedActionMemory,
    toolResultCache,
  });
  assert.equal(state.entryIntent, "run");
  assert.equal(state.reconciledWorkflowType, "editWorkflow");
  assert.equal(state.capabilityEscalations?.length, 1);
  assert.equal(state.budgetLedger?.preflightTools, 2);
  assert.ok(state.toolCacheEntries?.length);
});

test("restorePausedRunRuntimeState 恢复 escalation / 预算 / 缓存", () => {
  const { budgetManager, failedActionMemory, toolResultCache } = runtimeDeps();
  const targetEscalations: CapabilityEscalationRecord[] = [];
  const state = buildPausedRunRuntimeState({
    entryIntent: "edit",
    entryWorkflowType: "editWorkflow",
    reconciledIntent: "edit",
    reconciledWorkflowType: "editWorkflow",
    capabilityEscalations: [
      {
        fromWorkflow: "runWorkflow",
        fromIntent: "run",
        toWorkflow: "editWorkflow",
        toIntent: "edit",
        requestedTool: "shell_run",
        requestedPermission: "shell",
        currentExpectedSideEffects: ["read"],
        targetSideEffects: ["read", "shell"],
        canEscalate: true,
        reason: "shell",
        iteration: 2,
        applied: true,
      },
    ],
    budgetManager,
    failedActionMemory,
    toolResultCache,
  });
  const freshBudget = new BudgetManager(
    MODE_BASE_BUDGETS.implement,
    MODE_SUGGESTED_BUDGETS.implement,
  );
  const freshMemory = new FailedActionMemory();
  const freshCache = new RunToolResultCache();
  restorePausedRunRuntimeState(
    {
      capabilityEscalations: targetEscalations,
      failedActionMemory: freshMemory,
      toolResultCache: freshCache,
      budgetManager: freshBudget,
    },
    state,
  );
  assert.equal(targetEscalations.length, 1);
  assert.equal(freshBudget.ledgerSnapshot().preflightTools, 2);
  assert.ok(freshCache.exportState().length);
});

test("buildPausedRunSnapshot 深拷贝 messages 与 steps", () => {
  const messages = [{ role: "user" as const, content: "goal" }];
  const steps: AgentToolStep[] = [
    { iteration: 1, tool: "read_file", input: { path: "a.ts" }, permission: "read", ok: true },
  ];
  const snapshot = buildPausedRunSnapshot({
    runId: "run-1",
    goal: "goal",
    messages,
    steps,
    modelTurns: 1,
    mode: "implement",
    permissionPolicy: "confirmBeforeEdit",
    runtimeState: {},
  });
  messages[0]!.content = "mutated";
  steps.push({
    iteration: 2,
    tool: "write_file",
    input: { path: "b.ts" },
    permission: "write",
    ok: true,
  });
  assert.equal(snapshot.messages[0]?.content, "goal");
  assert.equal(snapshot.steps.length, 1);
  assert.equal(snapshot.createdAt.length > 0, true);
});

test("createJitPermissionRequestFromStep 创建 blockedTool 权限申请", () => {
  const store = new PermissionRequestStore();
  const step: AgentToolStep = {
    iteration: 1,
    tool: "write_file",
    input: { path: "README.md", content: "x" },
    permission: "write",
    blocked: true,
    confirmationRequest: {
      status: "waiting_confirmation",
      title: "写入确认",
      message: "需要写入 README.md",
      tool: "write_file",
      permission: "write",
      intent: "edit",
      permissionPolicy: "confirmBeforeEdit",
      action: "write_file README.md",
      affects: { files: ["README.md"], commands: [], networkTargets: [] },
      risk: {
        tier: "medium",
        category: "file_write",
        summary: "写入项目文件",
        reasons: [],
      },
    },
  };
  const payload = createJitPermissionRequestFromStep({
    permissionRequestStore: store,
    step,
    runId: "run-jit",
    sessionId: "sess-1",
    intent: "edit",
    executionStage: "execute",
    planVariant: "plan_then_execute",
  });
  assert.equal(payload.status, "pending");
  assert.equal(payload.blockedTool?.name, "write_file");
  assert.deepEqual(payload.blockedTool?.input, { path: "README.md", content: "x" });
  assert.equal(payload.planVariant, "plan_then_execute");
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
console.log(`\nagent-paused-run-snapshot: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
