/**
 * RunPolicyManager 运行策略解析自检。
 * 运行：npm run test:run-policy-manager
 */
import assert from "node:assert/strict";

import { defaultRunPolicyManager, RunPolicyManager } from "../src/agent/RunPolicy.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("inferMode 从计划模式文案推断 plan", () => {
  assert.equal(
    defaultRunPolicyManager.inferMode({ message: "请进入计划模式，只读分析当前项目" }),
    "plan",
  );
});

test("parseMode 拒绝非法 mode", () => {
  assert.equal(defaultRunPolicyManager.parseMode("invalid"), undefined);
  assert.equal(defaultRunPolicyManager.parseMode("plan"), "plan");
});

test("parsePermissionPolicy 拒绝非法策略", () => {
  assert.equal(defaultRunPolicyManager.parsePermissionPolicy("invalid"), undefined);
  assert.equal(defaultRunPolicyManager.parsePermissionPolicy("readOnly"), "readOnly");
  assert.equal(defaultRunPolicyManager.parsePermissionPolicy("autoRun"), "autoRun");
});

test("resolve 计划模式使用只读权限与更高默认预算", () => {
  const policy = defaultRunPolicyManager.resolve({ message: "请进入计划模式，只读分析当前项目" });
  assert.equal(policy.mode, "plan");
  assert.equal(policy.modeSource, "inferred");
  assert.equal(policy.intent, "plan");
  assert.equal(policy.workflowType, "planWorkflow");
  assert.equal(policy.permissionPolicy, "readOnly");
  assert.equal(policy.permissionPolicySource, "inferred");
  assert.equal(policy.budget.maxModelTurns, 16);
  assert.equal(policy.budget.maxWriteCalls, 0);
  assert.equal(policy.budget.maxShellCalls, 0);
  assert.deepEqual(policy.allowedPermissions, ["read"]);
  assert.match(policy.systemHint, /plan/);
});

test("resolve 的允许权限由 permissionPolicy 决定而不是 mode", () => {
  const planAutoRun = defaultRunPolicyManager.resolve({
    requestedMode: "plan",
    requestedPermissionPolicy: "autoRun",
    message: "只是在计划模式下验证显式权限策略",
  });
  assert.equal(planAutoRun.mode, "plan");
  assert.equal(planAutoRun.permissionPolicy, "autoRun");
  assert.deepEqual(planAutoRun.allowedPermissions, ["read", "write", "shell", "network", "dangerous"]);

  const debugReadOnly = defaultRunPolicyManager.resolve({
    requestedMode: "debug",
    requestedPermissionPolicy: "readOnly",
    message: "调试但只读",
  });
  assert.equal(debugReadOnly.mode, "debug");
  assert.equal(debugReadOnly.permissionPolicy, "readOnly");
  assert.deepEqual(debugReadOnly.allowedPermissions, ["read"]);
});

test("resolve 支持 budget 覆盖", () => {
  const policy = defaultRunPolicyManager.resolve({
    requestedMode: "plan",
    budget: { maxModelTurns: 1, maxReadCalls: 2 },
    message: "x",
  });
  assert.equal(policy.budget.maxModelTurns, 1);
  assert.equal(policy.budget.maxReadCalls, 2);
  assert.ok(policy.suggestedBudget.maxModelTurns >= 16);
});

test("resolve 支持显式权限策略覆盖推断", () => {
  const policy = defaultRunPolicyManager.resolve({
    message: "请运行测试验证结果",
    requestedPermissionPolicy: "confirmBeforeRun",
    autoConfirm: true,
  });
  assert.equal(policy.intent, "verify");
  assert.equal(policy.permissionPolicy, "confirmBeforeRun");
  assert.equal(policy.permissionPolicySource, "explicit");
});

test("resolve 根据意图与 autoConfirm 推断权限策略", () => {
  const edit = defaultRunPolicyManager.resolve({ message: "修改 src/app.ts" });
  assert.equal(edit.permissionPolicy, "confirmBeforeEdit");
  const autoEdit = defaultRunPolicyManager.resolve({ message: "修改 src/app.ts", autoConfirm: true });
  assert.equal(autoEdit.permissionPolicy, "autoEdit");
  const run = defaultRunPolicyManager.resolve({ message: "运行测试验证结果" });
  assert.equal(run.permissionPolicy, "confirmBeforeRun");
  const autoRun = defaultRunPolicyManager.resolve({ message: "运行测试验证结果", autoConfirm: true });
  assert.equal(autoRun.permissionPolicy, "autoRun");
});

test("createBudgetManager 与 policy 预算一致", () => {
  const policy = defaultRunPolicyManager.resolve({ requestedMode: "chat", message: "hi" });
  const mgr = defaultRunPolicyManager.createBudgetManager(policy);
  assert.deepEqual(mgr.budget, policy.budget);
  assert.deepEqual(mgr.suggestedBudget, policy.suggestedBudget);
});

test("独立实例可复用", () => {
  const custom = new RunPolicyManager();
  assert.equal(custom.resolve({ requestedMode: "debug", message: "x" }).mode, "debug");
  assert.equal(custom.resolve({ requestedMode: "debug", message: "x" }).intent, "debug");
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
console.log(`\nrun-policy-manager: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
