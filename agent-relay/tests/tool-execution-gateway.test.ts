/**
 * ToolExecutionGateway 统一执行入口自检。
 * 运行：npx tsx tests/tool-execution-gateway.test.ts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

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

test("rollback_change enriches changeId metadata before PathPolicy and PermissionGuard", async () => {
  const tmpRoot = path.join(process.cwd(), ".tmp-tests");
  await fs.mkdir(tmpRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(tmpRoot, "ar-gateway-rollback-"));
  const primary = path.join(root, "primary");
  const external = path.join(root, "external");
  await fs.mkdir(primary, { recursive: true });
  await fs.mkdir(external, { recursive: true });
  const externalFile = path.join(external, "shared.txt");
  await fs.writeFile(externalFile, "original", "utf-8");
  const registry = createDefaultRegistry({ dataDir: path.join(root, "data") });
  const gateway = new ToolExecutionGateway(registry);
  try {
    const write = await gateway.run({
      toolName: "write_file",
      input: { path: externalFile, content: "dirty", backup: true },
      source: "manual",
      budgetBucket: "manual",
      workspaceRoot: primary,
      allowedPermissions: ["read", "write"],
      intent: "edit",
      permissionPolicy: "autoEdit",
      scopedGrants: { write_file: [`${external}/**`] },
      skipBudgetCheck: true,
    });
    assert.equal(write.ok, true);
    const changeId = (write.output as { changeId?: string }).changeId;
    assert.equal(typeof changeId, "string");

    const blocked = await gateway.run({
      toolName: "rollback_change",
      input: { changeId },
      source: "manual",
      budgetBucket: "manual",
      workspaceRoot: primary,
      allowedPermissions: ["read", "write"],
      intent: "edit",
      permissionPolicy: "autoEdit",
      skipBudgetCheck: true,
    });
    assert.equal(blocked.executed, false);
    assert.equal(blocked.outcomeKind, "permission_denied");
    assert.equal(blocked.requiresUserAction, true);
    assert.match(blocked.message, /shared\.txt/);
    assert.equal(await fs.readFile(externalFile, "utf-8"), "dirty");
  } finally {
    registry.close();
    await fs.rm(root, { recursive: true, force: true });
  }
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
