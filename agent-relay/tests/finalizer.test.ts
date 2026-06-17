/**
 * Finalizer 与任务复杂度估算自检。
 * 运行：npm run test:finalizer
 */
import assert from "node:assert/strict";

import { Finalizer } from "../src/agent/Finalizer.js";
import { BudgetManager } from "../src/agent/BudgetManager.js";
import { resolveRunPolicy } from "../src/agent/RunPolicy.js";
import { estimateTaskComplexity, resolveSuggestedToolCalls } from "../src/agent/taskComplexity.js";
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

test("estimateTaskComplexity 计划模式项目分析为 medium 且提高 toolCalls", () => {
  const est = estimateTaskComplexity({
    goal: "只读分析当前项目结构与模块边界",
    mode: "plan",
  });
  assert.equal(est.tier, "medium");
  assert.ok(est.suggestedToolCalls >= 14);
});

test("estimateTaskComplexity 重构类任务为 high", () => {
  const est = estimateTaskComplexity({
    goal: "全量重构整个项目的模型路由架构",
    mode: "implement",
  });
  assert.equal(est.tier, "high");
  assert.ok(est.suggestedToolCalls >= 40);
});

test("resolveSuggestedToolCalls 在 maxToolCalls 耗尽时至少翻倍", () => {
  const policy = resolveRunPolicy({ requestedMode: "chat", forceMode: true, budget: { maxToolCalls: 3 }, message: "x" });
  const resolved = resolveSuggestedToolCalls({
    goal: "一直列目录",
    mode: "chat",
    budgetExhausted: "maxToolCalls",
    currentBudget: policy.budget,
    modeSuggestedToolCalls: policy.suggestedBudget.maxToolCalls,
    usedToolCalls: 3,
  });
  assert.ok(resolved.suggestedToolCalls >= 6);
});

test("Finalizer.buildPartialAnswer 含建议工具次数与待继续步骤", () => {
  const policy = resolveRunPolicy({
    requestedMode: "plan",
    forceMode: true,
    budget: { maxReadCalls: 2, maxToolCalls: 10 },
    message: "只读分析当前项目结构",
  });
  const mgr = new BudgetManager(policy.budget, policy.suggestedBudget);
  const finalizer = new Finalizer();
  const answer = finalizer.buildPartialAnswer({
    steps: [readStep(1), readStep(2)],
    budgetExhausted: "maxReadCalls",
    budgetManager: mgr,
    mode: "plan",
    goal: "只读分析当前项目结构",
  });
  assert.match(answer, /建议工具调用次数/);
  assert.match(answer, /待继续：project_scan/);
  assert.match(answer, /model_final_answer/);
});

test("Finalizer.buildBudgetExhaustedMeta 返回 completedSteps 与 suggestedToolCalls", () => {
  const policy = resolveRunPolicy({
    requestedMode: "plan",
    forceMode: true,
    budget: { maxModelTurns: 3 },
    message: "只读分析",
  });
  const mgr = new BudgetManager(policy.budget, policy.suggestedBudget);
  const finalizer = new Finalizer();
  const meta = finalizer.buildBudgetExhaustedMeta({
    steps: [readStep(1)],
    budgetExhausted: "maxModelTurns",
    budgetManager: mgr,
    mode: "plan",
    goal: "只读分析当前项目结构",
  });
  assert.deepEqual(meta.completedSteps, ["read_file#1"]);
  assert.ok(meta.suggestedToolCalls >= 14);
  assert.equal(meta.complexityTier, "medium");
  assert.ok(meta.missingSteps.includes("model_final_answer"));
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
console.log(`\nfinalizer: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
