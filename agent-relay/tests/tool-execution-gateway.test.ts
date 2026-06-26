/**
 * ToolExecutionGateway 统一执行入口自检。
 * 运行：npx tsx tests/tool-execution-gateway.test.ts
 */
import assert from "node:assert/strict";

import { ToolExecutionGateway } from "../src/agent/ToolExecutionGateway.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import { defaultWorkflowRouter } from "../src/agent/WorkflowRouter.js";

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

test("planWorkflow 下 write_file 被 workflow 硬阻断", () => {
  const registry = createDefaultRegistry();
  const gateway = new ToolExecutionGateway(registry);
  const evaluation = gateway.evaluate({
    toolName: "write_file",
    input: { path: "a.txt", content: "x" },
    source: "task_runner",
    budgetBucket: "main",
    workspaceRoot: process.cwd(),
    allowedPermissions: ["read", "write", "shell"],
    intent: "plan",
    permissionPolicy: "confirmBeforeEdit",
    mode: "plan",
    workflowRoute: defaultWorkflowRouter.routeIntent("plan"),
    skipBudgetCheck: true,
  });
  assert.equal(evaluation.blocked, true);
  assert.equal(evaluation.blockReasonKind, "workflow");
});

test("manual 路径 needsConfirmation 不自动执行 shell", async () => {
  const registry = createDefaultRegistry();
  const gateway = new ToolExecutionGateway(registry);
  const result = await gateway.run({
    toolName: "shell_run",
    input: { command: "echo hi" },
    source: "manual",
    budgetBucket: "manual",
    workspaceRoot: process.cwd(),
    allowedPermissions: ["read", "shell"],
    intent: "run",
    permissionPolicy: "confirmBeforeRun",
    mode: "implement",
    workflowRoute: defaultWorkflowRouter.routeIntent("run"),
    skipBudgetCheck: true,
  });
  assert.equal(result.executed, false);
  assert.equal(result.outcomeKind, "permission_denied");
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(error);
  }
}
console.log(`\ntool-execution-gateway: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
