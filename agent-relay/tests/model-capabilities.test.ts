/**
 * V5 ModelCapabilities 能力矩阵自检。
 * 运行：npm run test:model-capabilities
 */
import assert from "node:assert/strict";

import {
  buildCapabilityMatrixSnapshot,
  profileSatisfiesRequirements,
  resolveEffectiveRequirements,
  validateCapabilityMatrixCoverage,
} from "../src/model-router/model-capabilities.js";
import { ModelRegistry } from "../src/model-router/model-registry.js";
import type { ModelProfile, RuleRouteResult } from "../src/model-router/types.js";

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
  allowedTaskTypes: ["casual_chat", "simple_qa", "technical_qa", "document_qa"],
  allowedRoles: ["primary", "draft"],
  canDraft: true,
  canReview: false,
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
  allowedTaskTypes: ["architecture", "image_qa", "high_risk_action", "technical_qa"],
  allowedRoles: ["primary", "review", "final"],
  canDraft: false,
  canReview: true,
  canFinal: true,
};

const noVisionApi: ModelProfile = {
  ...apiStrong,
  id: "api-no-vision",
  supportsVision: false,
  allowedTaskTypes: ["technical_qa"],
};

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("resolveEffectiveRequirements 合并矩阵与 rule 覆盖", () => {
  const rule: RuleRouteResult = {
    taskType: "image_qa",
    requiredLevel: 2,
    risk: "medium",
    reason: "含图片",
    requireVision: true,
  };
  const req = resolveEffectiveRequirements(rule);
  assert.equal(req.minLevel, 3);
  assert.equal(req.supportsVision, true);
});

test("profileSatisfiesRequirements 拒绝无 vision 模型处理 image_qa", () => {
  const rule: RuleRouteResult = {
    taskType: "image_qa",
    requiredLevel: 3,
    risk: "medium",
    reason: "图片",
    requireVision: true,
  };
  const req = resolveEffectiveRequirements(rule);
  assert.equal(profileSatisfiesRequirements(noVisionApi, req, { role: "primary" }), false);
  assert.equal(profileSatisfiesRequirements(apiStrong, req, { role: "primary" }), true);
});

test("ModelRegistry findPrimaryCandidates 使用能力矩阵过滤", () => {
  const registry = new ModelRegistry([localDraft, apiStrong, noVisionApi]);
  const rule: RuleRouteResult = {
    taskType: "image_qa",
    requiredLevel: 3,
    risk: "medium",
    reason: "图片",
    requireVision: true,
  };
  const primary = registry.findPrimaryCandidates(rule);
  assert.deepEqual(
    primary.map((p) => p.id),
    ["api-strong"],
  );
});

test("validateCapabilityMatrixCoverage 报告 image_qa 缺口", () => {
  const warnings = validateCapabilityMatrixCoverage([localDraft, noVisionApi]);
  assert.ok(warnings.some((w) => w.includes("image_qa")));
});

test("buildCapabilityMatrixSnapshot 含 profiles/matrix/coverage", () => {
  const snapshot = buildCapabilityMatrixSnapshot([localDraft, apiStrong]);
  assert.ok(snapshot.profiles.length === 2);
  assert.ok(snapshot.matrix.length >= 10);
  assert.ok(snapshot.coverage.some((c) => c.taskType === "architecture"));
  assert.equal(snapshot.profiles[0]?.capabilities.maxInputTokens, localDraft.maxInputTokens);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
    console.log(`ok ${name}`);
  } catch (error) {
    console.error(`fail ${name}`);
    throw error;
  }
}
console.log(`\n${passed}/${tests.length} passed`);
