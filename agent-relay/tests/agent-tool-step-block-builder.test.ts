/**
 * AgentToolStepBlockBuilder 单元测试。
 * 运行：npm run test:agent-tool-step-block-builder
 */
import assert from "node:assert/strict";

import type { ToolAction } from "../src/agent/AgentActionParser.js";
import {
  buildBudgetBlockedToolStep,
  buildPathBlockedToolStep,
  buildPermissionBlockedToolStep,
  buildWorkflowBlockedToolStep,
} from "../src/agent/AgentToolStepBlockBuilder.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

const action: ToolAction = {
  action: "tool",
  tool: "write_file",
  input: { path: "README.md", content: "x" },
  thought: "update doc",
};

test("buildWorkflowBlockedToolStep 标记 workflow 阻断", () => {
  const step = buildWorkflowBlockedToolStep({
    action,
    iteration: 2,
    toolCallId: "tc-1",
    toolPermission: "write",
    block: { blocked: true, reason: "只读工作流禁止写入", outcomeKind: "readonly_mode_blocked" },
  });
  assert.equal(step.blockedReasonKind, "workflow");
  assert.equal(step.outcomeKind, "readonly_mode_blocked");
  assert.equal(step.error, "只读工作流禁止写入");
});

test("buildPermissionBlockedToolStep 标记 permission_denied", () => {
  const step = buildPermissionBlockedToolStep({
    action,
    iteration: 1,
    toolPermission: "write",
    reason: "权限策略已拒绝",
  });
  assert.equal(step.blockedReasonKind, "permission");
  assert.equal(step.outcomeKind, "permission_denied");
});

test("buildBudgetBlockedToolStep 标记 budget_exhausted", () => {
  const step = buildBudgetBlockedToolStep({
    action,
    iteration: 3,
    toolPermission: "write",
    budgetExhausted: "maxWriteCalls",
  });
  assert.equal(step.blockedReasonKind, "budget");
  assert.match(step.error ?? "", /maxWriteCalls/);
});

test("buildPathBlockedToolStep 跨工作区需确认时带 confirmationRequest", () => {
  const step = buildPathBlockedToolStep({
    action,
    iteration: 1,
    toolPermission: "write",
    intent: "edit",
    permissionPolicy: "confirmBeforeEdit",
    pathAccess: {
      workspaceRoot: "/ws",
      input: action.input ?? {},
      grantVersionKey: undefined,
      audit: {
        matchedRoot: "/other",
        crossWorkspace: true,
        permissionSource: "grant",
        pathRisk: "cross_workspace",
        pathRiskTier: "high",
      },
      decision: {
        allowed: false,
        needsConfirmation: true,
        normalizedPath: "README.md",
        reason: "cross_workspace",
        requiredPermission: "write",
        crossWorkspace: true,
        pathRisk: { tier: "high", reasons: ["cross_workspace"] },
      },
    },
  });
  assert.equal(step.outcomeKind, "permission_required");
  assert.equal(step.confirmationRequest?.status, "waiting_confirmation");
  assert.ok(step.workspaceAccess?.crossWorkspace);
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
console.log(`\nagent-tool-step-block-builder: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
