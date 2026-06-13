/**
 * PermissionGuard 权限策略判定自检。
 * 运行：npm run test:permission-guard
 */
import assert from "node:assert/strict";

import { evaluatePermissionGuard } from "../src/policy/PermissionGuard.js";
import { ALL_PERMISSIONS } from "../src/agent/permissions.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("readOnly 拒绝写入", () => {
  const decision = evaluatePermissionGuard({
    intent: "answer",
    permissionPolicy: "readOnly",
    toolName: "write_file",
    permission: "write",
    input: { path: "a.txt" },
    allowedPermissions: ALL_PERMISSIONS,
  });
  assert.equal(decision.decision, "deny");
  assert.equal(decision.risk.policyBlocked, true);
  assert.match(decision.reason ?? "", /readOnly/);
});

test("confirmBeforeEdit 对写入返回 needsConfirmation", () => {
  const decision = evaluatePermissionGuard({
    intent: "edit",
    permissionPolicy: "confirmBeforeEdit",
    toolName: "write_file",
    permission: "write",
    input: { path: "a.txt" },
    allowedPermissions: ALL_PERMISSIONS,
  });
  assert.equal(decision.decision, "needsConfirmation");
  assert.equal(decision.risk.requiresConfirmation, true);
});

test("autoEdit 允许写入但不允许 shell", () => {
  const write = evaluatePermissionGuard({
    intent: "edit",
    permissionPolicy: "autoEdit",
    toolName: "write_file",
    permission: "write",
    input: { path: "a.txt" },
    allowedPermissions: ALL_PERMISSIONS,
  });
  assert.equal(write.decision, "allow");

  const shell = evaluatePermissionGuard({
    intent: "edit",
    permissionPolicy: "autoEdit",
    toolName: "shell_run",
    permission: "shell",
    input: { command: "npm test" },
    allowedPermissions: ALL_PERMISSIONS,
  });
  assert.equal(shell.decision, "deny");
});

test("confirmBeforeRun 对 shell 返回 needsConfirmation", () => {
  const decision = evaluatePermissionGuard({
    intent: "verify",
    permissionPolicy: "confirmBeforeRun",
    toolName: "shell_run",
    permission: "shell",
    input: { command: "npm test" },
    allowedPermissions: ALL_PERMISSIONS,
  });
  assert.equal(decision.decision, "needsConfirmation");
  assert.equal(decision.risk.category, "shell_command");
});

test("allowedPermissions 是硬上限", () => {
  const decision = evaluatePermissionGuard({
    intent: "edit",
    permissionPolicy: "autoEdit",
    toolName: "write_file",
    permission: "write",
    input: { path: "a.txt" },
    allowedPermissions: ["read"],
  });
  assert.equal(decision.decision, "deny");
  assert.match(decision.reason ?? "", /当前模式不允许/);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    throw error;
  }
}
console.log(`permission-guard: ${passed}/${tests.length} passed`);
