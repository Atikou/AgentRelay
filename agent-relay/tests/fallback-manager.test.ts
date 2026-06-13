/**
 * FallbackManager 计划生成与升级路径（无需网络）。
 */
import assert from "node:assert/strict";

import { FallbackManager, MAX_FALLBACKS_PER_REQUEST } from "../src/model-router/fallback-manager.js";
import { ModelRegistry } from "../src/model-router/model-registry.js";
import type { ModelProfile, RouterDecision } from "../src/model-router/types.js";

const localDraft: ModelProfile = {
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
  allowedTaskTypes: ["casual_chat", "simple_qa", "architecture", "document_qa", "technical_qa"],
  allowedRoles: ["primary", "draft"],
  canDraft: true,
  canReview: false,
  canFinal: true,
};

const apiGeneral: ModelProfile = {
  id: "api-general",
  displayName: "普通 API",
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
  allowedTaskTypes: ["technical_qa", "architecture", "document_qa"],
  allowedRoles: ["primary", "review", "final"],
  canDraft: true,
  canReview: true,
  canFinal: true,
};

const apiStrong: ModelProfile = {
  id: "api-strong",
  displayName: "强 API",
  provider: "api",
  defaultLevel: 3,
  enabled: true,
  supportsStreaming: true,
  supportsTools: true,
  supportsVision: true,
  supportsJsonMode: true,
  maxInputTokens: 128000,
  maxOutputTokens: 8192,
  relativeCost: "high",
  allowedTaskTypes: ["architecture", "technical_qa", "document_qa"],
  allowedRoles: ["primary", "review", "final"],
  canDraft: false,
  canReview: true,
  canFinal: true,
};

const registry = new ModelRegistry([localDraft, apiGeneral, apiStrong]);
const manager = new FallbackManager(registry);

const baseDecision: RouterDecision = {
  id: "route-1",
  taskType: "technical_qa",
  selectedLevel: 1,
  risk: "medium",
  reason: "test",
  source: "rule",
  executionStrategy: "single_model",
  selectedModelId: "local-small",
  requireUserConfirmation: false,
  candidates: ["local-small", "api-general", "api-strong"],
  createdAt: new Date().toISOString(),
};

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("MAX_FALLBACKS_PER_REQUEST 为 2", () => {
  assert.equal(MAX_FALLBACKS_PER_REQUEST, 2);
});

test("单模型 model_error 升级到 L2", () => {
  const plan = manager.plan(baseDecision, "model_error", { fromModelId: "local-small" });
  assert.ok(plan);
  assert.equal(plan.toModelId, "api-general");
  assert.equal(plan.toStrategy, "single_model");
});

test("localOnly 时单模型失败不会升级到远程", () => {
  const plan = manager.plan(baseDecision, "model_error", {
    fromModelId: "local-small",
    localOnly: true,
  });
  assert.equal(plan, null);
});

test("单模型 empty_output 可升级到 strong_model_direct", () => {
  const decision: RouterDecision = {
    ...baseDecision,
    selectedModelId: "api-general",
    selectedLevel: 2,
  };
  const plan = manager.plan(decision, "empty_output", { fromModelId: "api-general" });
  assert.ok(plan);
  assert.equal(plan.toModelId, "api-strong");
  assert.equal(plan.toStrategy, "strong_model_direct");
});

test("applyPlan 将 strong_model_direct 写入 selectedModelId", () => {
  const plan = manager.plan(baseDecision, "model_error", { fromModelId: "local-small" })!;
  const upgraded = manager.applyPlan(
    {
      ...baseDecision,
      executionStrategy: "local_draft_remote_review",
      draftModelId: "local-small",
      reviewModelId: "api-general",
      finalModelId: "api-general",
    },
    {
      fromModelId: "local-small",
      toModelId: "api-strong",
      fromStrategy: "local_draft_remote_review",
      toStrategy: "strong_model_direct",
      trigger: "review_rejected",
      reason: "test",
      maxAttempts: 1,
    },
  );
  assert.equal(upgraded.executionStrategy, "strong_model_direct");
  assert.equal(upgraded.selectedModelId, "api-strong");
});

test("协作 review_rejected 升级强模型", () => {
  const decision: RouterDecision = {
    ...baseDecision,
    executionStrategy: "local_draft_remote_review",
    draftModelId: "local-small",
    reviewModelId: "api-general",
    finalModelId: "api-general",
    selectedModelId: undefined,
  };
  const plan = manager.plan(decision, "review_rejected", {
    fromModelId: "api-general",
    usedModelIds: ["local-small", "api-general"],
  });
  assert.ok(plan);
  assert.equal(plan.toStrategy, "strong_model_direct");
  assert.equal(plan.toModelId, "api-strong");
});

test("localOnly 时协作失败不会升级到远程强模型", () => {
  const decision: RouterDecision = {
    ...baseDecision,
    executionStrategy: "local_draft_remote_review",
    draftModelId: "local-small",
    reviewModelId: "api-general",
    finalModelId: "api-general",
    selectedModelId: undefined,
  };
  const plan = manager.plan(decision, "review_rejected", {
    fromModelId: "api-general",
    usedModelIds: ["local-small", "api-general"],
    localOnly: true,
  });
  assert.equal(plan, null);
});

test("detectOutputIssue 复杂任务过短答案触发 answer_too_short", () => {
  const archDecision: RouterDecision = {
    ...baseDecision,
    taskType: "architecture",
    selectedLevel: 3,
  };
  const trigger = manager.detectOutputIssue(archDecision, "太短", "请设计完整架构方案并说明模块边界");
  assert.equal(trigger, "answer_too_short");
});

test("detectOutputIssue 空字符串触发 empty_output", () => {
  assert.equal(manager.detectOutputIssue(baseDecision, "   ", "hi"), "empty_output");
});

test("已达 L3 时 model_error 不再生成 plan", () => {
  const decision: RouterDecision = {
    ...baseDecision,
    selectedModelId: "api-strong",
    selectedLevel: 3,
    executionStrategy: "strong_model_direct",
  };
  const plan = manager.plan(decision, "model_error", { fromModelId: "api-strong" });
  assert.equal(plan, null);
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
console.log(`\nfallback-manager: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
