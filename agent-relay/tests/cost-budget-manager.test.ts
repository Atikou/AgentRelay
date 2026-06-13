/**
 * CostBudgetManager（V8）自检。
 * 运行：npm run test:cost-budget-manager
 */
import assert from "node:assert/strict";

import { DecisionEngine } from "../src/model-router/decision-engine.js";
import { CostBudgetManager } from "../src/model-router/cost-budget-manager.js";
import { ModelRegistry } from "../src/model-router/model-registry.js";
import { SmartModelRouter } from "../src/model-router/smart-model-router.js";
import type { ModelProfile } from "../src/model-router/types.js";

const localFree: ModelProfile = {
  id: "local-free",
  displayName: "本地",
  provider: "local",
  defaultLevel: 1,
  enabled: true,
  supportsStreaming: true,
  supportsTools: true,
  supportsVision: false,
  supportsJsonMode: false,
  maxInputTokens: 8192,
  maxOutputTokens: 2048,
  relativeCost: "free",
  allowedTaskTypes: ["simple_qa", "technical_qa", "casual_chat"],
  allowedRoles: ["primary", "draft"],
  canDraft: true,
  canReview: false,
  canFinal: true,
};

const apiMedium: ModelProfile = {
  id: "api-medium",
  displayName: "中等 API",
  provider: "api",
  defaultLevel: 2,
  enabled: true,
  supportsStreaming: true,
  supportsTools: true,
  supportsVision: false,
  supportsJsonMode: true,
  maxInputTokens: 32000,
  maxOutputTokens: 4096,
  relativeCost: "medium",
  allowedTaskTypes: ["simple_qa", "technical_qa"],
  allowedRoles: ["primary", "review", "final"],
  canDraft: true,
  canReview: true,
  canFinal: true,
};

const apiCheap: ModelProfile = {
  ...apiMedium,
  id: "api-cheap",
  displayName: "便宜 API",
  defaultLevel: 1,
  relativeCost: "medium",
  allowedTaskTypes: ["simple_qa", "technical_qa", "casual_chat"],
};

const apiHigh: ModelProfile = {
  ...apiMedium,
  id: "api-high",
  displayName: "高价 API",
  defaultLevel: 2,
  relativeCost: "high",
};

const manager = new CostBudgetManager();
const registry = new ModelRegistry([apiHigh, apiCheap, localFree]);
const router = new SmartModelRouter(registry, undefined, undefined, manager);

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("qualityMode=fast 产生 soft 压力并倾向便宜模型", () => {
  const ranked = manager.rankCandidates([apiHigh, localFree, apiMedium], {
    userInput: "hello",
    qualityMode: "fast",
  });
  assert.equal(ranked.candidates[0]!.id, "local-free");
  assert.ok(ranked.signals.includes("quality_fast=prefer_cheaper"));
});

test("预算将尽时 tight 压力降权高价模型", () => {
  const ranked = manager.rankCandidates([apiHigh, apiCheap, localFree], {
    userInput: "分析",
    maxCostUsd: 0.1,
    spentCostUsd: 0.09,
  });
  assert.equal(ranked.candidates[0]!.id, "local-free");
  assert.equal(ranked.context.pressure, "tight");
});

test("Smart 路由 fast 模式 source=cost_budget", () => {
  const decision = router.route({
    userInput: "简单问题",
    taskTypeOverride: "simple_qa",
    qualityMode: "fast",
  });
  assert.equal(decision.selectedModelId, "local-free");
  assert.equal(decision.source, "cost_budget");
  assert.match(decision.reason, /V8 成本预算/);
});

test("DecisionEngine 无预算压力时保持默认首选", () => {
  const engine = new DecisionEngine(new ModelRegistry([localFree]));
  const decision = engine.decide(
    {
      taskType: "casual_chat",
      requiredLevel: 1,
      risk: "low",
      reason: "test",
      preferredStrategy: "single_model",
      preferCollaboration: false,
    },
    { userInput: "hi", qualityMode: "balanced" },
  );
  assert.equal(decision.selectedModelId, "local-free");
  assert.equal(decision.source, "rule");
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}
console.log(`\ncost-budget-manager: ${passed}/${tests.length} passed`);
