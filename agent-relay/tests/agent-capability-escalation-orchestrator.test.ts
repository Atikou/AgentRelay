/**
 * AgentCapabilityEscalationOrchestrator 单元测试。
 * 运行：npm run test:agent-capability-escalation-orchestrator
 */
import assert from "node:assert/strict";

import type { ToolAction } from "../src/agent/AgentActionParser.js";
import { reconcileCapabilityBeforeTool } from "../src/agent/AgentCapabilityEscalationOrchestrator.js";
import { BudgetManager } from "../src/agent/BudgetManager.js";
import type { CapabilityEscalationRecord } from "../src/agent/CapabilityEscalation.js";
import { MODE_BASE_BUDGETS, MODE_SUGGESTED_BUDGETS } from "../src/agent/runBudgetDefaults.js";
import { defaultWorkflowRouter } from "../src/agent/WorkflowRouter.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

const runWorkflowRoute = defaultWorkflowRouter.routeIntent("run");

test("soft workflow 写工具触发 escalation 并注入系统消息", () => {
  const escalations: CapabilityEscalationRecord[] = [];
  const messages: Array<{ role: string; content: string }> = [];
  const budgetManager = new BudgetManager(
    { ...MODE_BASE_BUDGETS.implement, maxWriteCalls: 0 },
    MODE_SUGGESTED_BUDGETS.implement,
  );
  const action: ToolAction = { action: "tool", tool: "write_file", input: { path: "a.ts" } };
  const timelineEvents: string[] = [];

  const result = reconcileCapabilityBeforeTool({
    action,
    toolPermission: "write",
    workflowRoute: runWorkflowRoute,
    iteration: 2,
    messages: messages as never,
    capabilityEscalations: escalations,
    budgetManager,
    permissionPolicy: "autoRun",
    runId: "run-esc",
    timeline: {
      recordCapabilityEscalation: (e) => {
        timelineEvents.push(e.title);
      },
    },
  });

  assert.equal(result.reconciledIntent, "debug");
  assert.equal(result.reconciledWorkflowType, "debugWorkflow");
  assert.equal(escalations.length, 1);
  assert.ok(messages.some((m) => m.content.includes("Capability escalation")));
  assert.ok(timelineEvents.some((t) => t.includes("debugWorkflow")));
  assert.ok(budgetManager.budget.maxWriteCalls > 0);
});

test("相同 tool+permission 不重复记录 escalation", () => {
  const escalations: CapabilityEscalationRecord[] = [];
  const budgetManager = new BudgetManager(MODE_BASE_BUDGETS.implement, MODE_SUGGESTED_BUDGETS.implement);
  const action: ToolAction = { action: "tool", tool: "write_file", input: { path: "b.ts" } };
  const input = {
    action,
    toolPermission: "write" as const,
    workflowRoute: runWorkflowRoute,
    iteration: 1,
    capabilityEscalations: escalations,
    budgetManager,
    permissionPolicy: "confirmBeforeEdit" as const,
  };
  reconcileCapabilityBeforeTool(input);
  reconcileCapabilityBeforeTool({ ...input, iteration: 2 });
  assert.equal(escalations.length, 1);
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
console.log(`\nagent-capability-escalation-orchestrator: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
