/**
 * V3/V4 评估器运行时自检。
 */
import assert from "node:assert/strict";

import {
  AnswerEvaluator,
  DecisionEngine,
  ModelRegistry,
  RouterModelEvaluator,
  type ModelProfile,
  type RouterDecision,
  type RuleRouteResult,
} from "../src/model-router/index.js";

const profile: ModelProfile = {
  id: "local-small",
  displayName: "本地轻量",
  provider: "local",
  defaultLevel: 1,
  enabled: true,
  supportsStreaming: true,
  supportsTools: false,
  supportsVision: false,
  supportsJsonMode: false,
  maxInputTokens: 8192,
  maxOutputTokens: 2048,
  relativeCost: "free",
  allowedTaskTypes: ["simple_qa", "architecture"],
  allowedRoles: ["primary", "draft"],
  canDraft: true,
  canReview: false,
  canFinal: true,
};

const rule: RuleRouteResult = {
  taskType: "architecture",
  requiredLevel: 2,
  risk: "medium",
  reason: "测试规则",
  preferredStrategy: "local_draft_remote_review",
};

const decision: RouterDecision = {
  id: "route-eval-test",
  taskType: "architecture",
  selectedLevel: 2,
  risk: "medium",
  reason: "测试",
  source: "rule",
  executionStrategy: "single_model",
  selectedModelId: "local-small",
  requireUserConfirmation: false,
  candidates: ["local-small"],
  createdAt: new Date().toISOString(),
};

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("RouterModelEvaluator 高风险任务不覆盖规则", () => {
  const unknownHighRisk = {
    taskType: "unknown" as const,
    requiredLevel: 3 as const,
    risk: "high" as const,
    reason: "高风险未知",
    preferredStrategy: "single_model" as const,
  };
  const strong = { ...profile, id: "api-strong", defaultLevel: 3 as const, provider: "api" as const };
  const evaluation = new RouterModelEvaluator().evaluate({
    routerInput: { userInput: "部署到生产" },
    rule: unknownHighRisk,
    candidates: [profile, strong],
  });
  assert.equal(evaluation.shouldOverrideRule, false);
  assert.equal(evaluation.source, "stub");
});

test("RouterModelEvaluator stub 不覆盖规则决策", () => {
  const evaluation = new RouterModelEvaluator().evaluate({
    routerInput: { userInput: "帮我设计架构" },
    rule,
    candidates: [profile],
  });
  assert.equal(evaluation.source, "stub");
  assert.equal(evaluation.shouldOverrideRule, false);
  assert.equal(evaluation.recommendedStrategy, "local_draft_remote_review");
  assert.equal(evaluation.recommendedModelId, "local-small");
});

test("RouterModelEvaluator V3 unknown 任务启发式覆盖", () => {
  const unknownRule = {
    taskType: "unknown" as const,
    requiredLevel: 2 as const,
    risk: "low" as const,
    reason: "默认兜底",
    preferredStrategy: "single_model" as const,
  };
  const strong = { ...profile, id: "api-strong", defaultLevel: 3 as const, provider: "api" as const };
  const evaluation = new RouterModelEvaluator().evaluate({
    routerInput: { userInput: "帮我看看", qualityMode: "deep" },
    rule: unknownRule,
    candidates: [profile, strong],
  });
  assert.equal(evaluation.source, "heuristic_v3");
  assert.equal(evaluation.shouldOverrideRule, true);
  assert.equal(evaluation.recommendedModelId, "api-strong");
});

test("DecisionEngine unknown 任务 source=evaluator", () => {
  const local = profile;
  const strong: ModelProfile = {
    ...profile,
    id: "api-strong",
    defaultLevel: 3,
    provider: "api",
    allowedTaskTypes: ["unknown", "architecture", "simple_qa"],
    allowedRoles: ["primary", "final"],
  };
  const registry = new ModelRegistry([local, strong]);
  const engine = new DecisionEngine(registry);
  const unknownRule: RuleRouteResult = {
    taskType: "unknown",
    requiredLevel: 2,
    risk: "low",
    reason: "默认兜底",
    preferredStrategy: "single_model",
  };
  const picked = engine.decide(unknownRule, { userInput: "随便", forceSingleModel: true });
  assert.equal(picked.source, "evaluator");
  assert.equal(picked.selectedModelId, "api-strong");
});

test("RouterModelEvaluator stub 标记无候选警告", () => {
  const evaluation = new RouterModelEvaluator().evaluate({
    routerInput: { userInput: "帮我设计架构" },
    rule,
    candidates: [],
  });
  assert.equal(evaluation.shouldOverrideRule, false);
  assert.ok(evaluation.warnings.includes("no_candidate_profiles_provided"));
});

test("AnswerEvaluator 识别空输出", () => {
  const evaluation = new AnswerEvaluator().evaluate({
    decision,
    answer: "   ",
    userInput: "帮我设计架构",
  });
  assert.equal(evaluation.verdict, "needs_fallback");
  assert.equal(evaluation.trigger, "empty_output");
});

test("AnswerEvaluator 识别复杂任务回答过短", () => {
  const evaluation = new AnswerEvaluator().evaluate({
    decision,
    answer: "太短",
    userInput: "帮我设计架构",
  });
  assert.equal(evaluation.verdict, "needs_fallback");
  assert.equal(evaluation.trigger, "answer_too_short");
});

test("AnswerEvaluator 通过足够回答", () => {
  const evaluation = new AnswerEvaluator().evaluate({
    decision,
    answer: "这是一个足够长的架构说明，包含模块边界、调用链路、风险控制、验证方式和后续演进建议，能够满足当前规则版评估的最小长度要求。它还会说明数据持久化、安全审计、模型 fallback 与测试策略之间的关系。",
    userInput: "帮我设计架构",
  });
  assert.equal(evaluation.verdict, "pass");
  assert.equal(evaluation.score, 1);
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`  ✓ ${t.name}`);
    passed += 1;
  } catch (error) {
    console.error(`  ✗ ${t.name}\n    ${String(error)}`);
    failed += 1;
  }
}
console.log(`\nrouter-evaluators: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
