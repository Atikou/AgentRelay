/**
 * RunPolicyManager 运行策略解析自检。
 * 运行：npm run test:run-policy-manager
 */
import assert from "node:assert/strict";

import { defaultRunPolicyManager, RunPolicyManager } from "../src/agent/RunPolicy.js";
import { defaultWorkflowSessionStore } from "../src/agent/WorkflowSessionSwitch.js";

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
  assert.equal(policy.executionStage, "plan");
  assert.equal(policy.afterPlan, "final");
  assert.equal(policy.planVariant, "plan_only");
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
    forceMode: true,
    requestedPermissionPolicy: "autoRun",
    message: "只是在计划模式下验证显式权限策略",
  });
  assert.equal(planAutoRun.mode, "plan");
  assert.equal(planAutoRun.permissionPolicy, "autoRun");
  assert.deepEqual(planAutoRun.allowedPermissions, ["read", "write", "shell", "network", "dangerous"]);

  const debugReadOnly = defaultRunPolicyManager.resolve({
    requestedMode: "debug",
    forceMode: true,
    requestedPermissionPolicy: "readOnly",
    message: "调试但只读",
  });
  assert.equal(debugReadOnly.mode, "debug");
  assert.equal(debugReadOnly.permissionPolicy, "readOnly");
  assert.deepEqual(debugReadOnly.allowedPermissions, ["read"]);
});

test("answer/summarize/search 工作流即使显式自动策略也保持只读工具上限", () => {
  const answer = defaultRunPolicyManager.resolve({
    message: "你好，回答一个问题",
    requestedPermissionPolicy: "autoRun",
  });
  assert.equal(answer.intent, "answer");
  assert.equal(answer.permissionPolicy, "autoRun");
  assert.deepEqual(answer.allowedPermissions, ["read"]);

  const search = defaultRunPolicyManager.resolve({
    message: "查找 AgentLoop 在哪里",
    requestedPermissionPolicy: "autoRun",
  });
  assert.equal(search.intent, "search");
  assert.equal(search.permissionPolicy, "autoRun");
  assert.deepEqual(search.allowedPermissions, ["read"]);
});

test("resolve 支持 budget 覆盖", () => {
  const policy = defaultRunPolicyManager.resolve({
    requestedMode: "plan",
    forceMode: true,
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
  const policy = defaultRunPolicyManager.resolve({ requestedMode: "chat", forceMode: true, message: "hi" });
  const mgr = defaultRunPolicyManager.createBudgetManager(policy);
  assert.deepEqual(mgr.budget, policy.budget);
  assert.deepEqual(mgr.suggestedBudget, policy.suggestedBudget);
});

test("独立实例可复用", () => {
  const custom = new RunPolicyManager();
  assert.equal(custom.resolve({ requestedMode: "debug", forceMode: true, message: "x" }).mode, "debug");
  assert.equal(custom.resolve({ requestedMode: "debug", forceMode: true, message: "x" }).intent, "debug");
});

test("plan_then_execute 复合意图进入权限申请后续", () => {
  const policy = defaultRunPolicyManager.resolve({
    message: "先分析项目，制定 README 修改计划，然后按计划执行",
  });
  assert.equal(policy.intent, "plan");
  assert.equal(policy.planVariant, "plan_then_execute");
  assert.equal(policy.afterPlan, "request_permission_then_execute");
});

test("短句续写会沿用同会话上轮工作流", () => {
  const sessionId = "session-carry-over";
  defaultWorkflowSessionStore.set({
    sessionId,
    intent: "edit",
    workflowType: "editWorkflow",
    updatedAt: new Date().toISOString(),
  });
  const policy = defaultRunPolicyManager.resolve({
    sessionId,
    message: "继续改",
  });
  assert.equal(policy.intent, "edit");
  assert.equal(policy.workflowType, "editWorkflow");
  assert.equal(policy.mode, "implement");
  assert.equal(policy.executionStage, "execute");
  defaultWorkflowSessionStore.clear(sessionId);
});

test("plan 会话收到执行短句时不跃迁绕过权限批准", () => {
  const sessionId = "session-plan-no-bypass";
  defaultWorkflowSessionStore.set({
    sessionId,
    intent: "plan",
    workflowType: "planWorkflow",
    updatedAt: new Date().toISOString(),
  });
  const policy = defaultRunPolicyManager.resolve({
    sessionId,
    message: "继续，按计划开始执行",
  });
  assert.notEqual(policy.intent, "edit");
  assert.notEqual(policy.mode, "implement");
  assert.notEqual(policy.workflowType, "editWorkflow");
  defaultWorkflowSessionStore.clear(sessionId);
});

test("粘贴工具失败步骤输出沿用同会话上轮 implement 工作流", () => {
  const sessionId = "session-failure-feedback";
  defaultWorkflowSessionStore.set({
    sessionId,
    intent: "edit",
    workflowType: "editWorkflow",
    updatedAt: new Date().toISOString(),
  });
  const pasted = [
    "#2 read_file",
    "163ms",
    "想法：检查是否有 vite.config.ts 配置文件",
    '入参 {"path":"testTS/vite.config.ts"}',
    "[error] Error: ENOENT: no such file or directory",
  ].join("\n");
  const policy = defaultRunPolicyManager.resolve({
    sessionId,
    message: pasted,
  });
  assert.equal(policy.intent, "edit");
  assert.equal(policy.workflowType, "editWorkflow");
  assert.equal(policy.mode, "implement");
  assert.notEqual(policy.intent, "answer");
  assert.equal(policy.intentDecisionSource, "session_continuation");
  defaultWorkflowSessionStore.clear(sessionId);
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
