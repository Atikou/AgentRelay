/**
 * BudgetManager 分项预算自检。
 * 运行：npm run test:budget-manager
 */
import assert from "node:assert/strict";

import { BudgetManager, countSuccessfulPermissionUsage } from "../src/agent/BudgetManager.js";
import { resolveRunPolicy } from "../src/agent/RunPolicy.js";
import type { AgentToolStep } from "../src/agent/toolStep.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

const readStep = (n: number): AgentToolStep => ({
  iteration: n,
  tool: "read_file",
  input: {},
  permission: "read",
  ok: true,
});

test("findToolExhaustion 在 read 预算用尽时返回 maxReadCalls", () => {
  const policy = resolveRunPolicy({
    requestedMode: "plan",
    forceMode: true,
    budget: { maxReadCalls: 2, maxToolCalls: 10 },
    message: "x",
  });
  const mgr = new BudgetManager(policy.budget, policy.suggestedBudget);
  const steps = [readStep(1), readStep(2)];
  assert.equal(
    mgr.findToolExhaustion({ toolPermission: "read", permissionAllowed: true, steps }),
    "maxReadCalls",
  );
});

test("findToolExhaustion 在 maxToolCalls 用尽时优先返回 maxToolCalls", () => {
  const policy = resolveRunPolicy({ requestedMode: "chat", forceMode: true, budget: { maxToolCalls: 2 }, message: "x" });
  const mgr = new BudgetManager(policy.budget, policy.suggestedBudget);
  const steps: AgentToolStep[] = [
    { iteration: 1, tool: "a", input: {}, ok: false },
    { iteration: 2, tool: "b", input: {}, ok: false },
  ];
  assert.equal(
    mgr.findToolExhaustion({ toolPermission: "read", permissionAllowed: true, steps }),
    "maxToolCalls",
  );
});

test("buildSuggestedBudget 将耗尽项翻倍但不低于建议值", () => {
  const policy = resolveRunPolicy({
    requestedMode: "plan",
    forceMode: true,
    budget: { maxReadCalls: 3 },
    message: "x",
  });
  const mgr = new BudgetManager(policy.budget, policy.suggestedBudget);
  const suggested = mgr.buildSuggestedBudget("maxReadCalls");
  assert.ok(suggested.maxReadCalls >= 6);
  assert.ok(suggested.maxReadCalls >= policy.suggestedBudget.maxReadCalls);
});

test("remainingWorkflowSteps 扣除已用 tool/read 配额", () => {
  const policy = resolveRunPolicy({
    requestedMode: "plan",
    forceMode: true,
    budget: { maxToolCalls: 5, maxReadCalls: 2 },
    message: "x",
  });
  const mgr = new BudgetManager(policy.budget, policy.suggestedBudget);
  const steps = [readStep(1)];
  assert.equal(mgr.remainingWorkflowSteps(steps, 3), 1);
});

test("countSuccessfulPermissionUsage 只统计成功步骤", () => {
  const usage = countSuccessfulPermissionUsage([
    readStep(1),
    { iteration: 2, tool: "write_file", input: {}, permission: "write", ok: false, outcomeClass: "observation_failure" },
    { iteration: 3, tool: "write_file", input: {}, permission: "write", ok: true, outcomeClass: "observation_success", executed: true },
  ]);
  assert.equal(usage.readCalls, 1);
  assert.equal(usage.writeCalls, 1);
});

test("buildUsage 统计 outcome 失败分项", () => {
  const policy = resolveRunPolicy({ requestedMode: "chat", forceMode: true, message: "x" });
  const mgr = new BudgetManager(policy.budget, policy.suggestedBudget);
  mgr.markRunStarted();
  const usage = mgr.buildUsage(
    [
      { iteration: 1, tool: "read_file", input: {}, ok: false, outcomeClass: "observation_failure", executed: true },
      { iteration: 2, tool: "x", input: {}, blocked: true, ok: false },
    ],
    1,
  );
  assert.equal(usage.toolObservationFailures, 1);
  assert.equal(usage.toolExecutionErrors, 0);
  assert.equal(usage.toolFailures, 1);
});

test("零配额 shell 不视为预算耗尽", () => {
  const policy = resolveRunPolicy({
    requestedMode: "review",
    forceMode: true,
    message: "x",
  });
  const mgr = new BudgetManager(policy.budget, policy.suggestedBudget);
  assert.equal(
    mgr.findToolExhaustion({ toolPermission: "shell", permissionAllowed: true, steps: [] }),
    undefined,
  );
});

test("shell 预算在第三次调用时耗尽", () => {
  const policy = resolveRunPolicy({
    requestedMode: "implement",
    forceMode: true,
    budget: { maxShellCalls: 2 },
    message: "x",
  });
  const mgr = new BudgetManager(policy.budget, policy.suggestedBudget);
  const shellStep = (n: number): AgentToolStep => ({
    iteration: n,
    tool: "shell_run",
    input: {},
    permission: "shell",
    ok: true,
    executed: true,
    outcomeClass: "observation_success",
  });
  const two = [shellStep(1), shellStep(2)];
  assert.equal(
    mgr.findToolExhaustion({ toolPermission: "shell", permissionAllowed: true, steps: [shellStep(1)] }),
    undefined,
  );
  assert.equal(
    mgr.findToolExhaustion({ toolPermission: "shell", permissionAllowed: true, steps: two }),
    "maxShellCalls",
  );
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
console.log(`\nbudget-manager: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
