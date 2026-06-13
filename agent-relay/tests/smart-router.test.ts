/**
 * SmartModelRouter / RuleRouter / DecisionEngine 自检（无需网络）。
 */
import assert from "node:assert/strict";

import { DecisionEngine } from "../src/model-router/decision-engine.js";
import { ModelRegistry } from "../src/model-router/model-registry.js";
import { RuleRouter } from "../src/model-router/route-rules.js";
import { SmartModelRouter } from "../src/model-router/smart-model-router.js";
import { validateModelProfiles } from "../src/model-router/model-profiles.js";
import type { ModelProfile } from "../src/model-router/types.js";

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
  allowedTaskTypes: [
    "casual_chat",
    "simple_qa",
    "memory_write",
    "technical_qa",
    "architecture",
    "document_qa",
  ],
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
  allowedTaskTypes: ["technical_qa", "code_question", "debug", "document_qa", "architecture"],
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
  allowedTaskTypes: [
    "architecture",
    "code_edit",
    "high_risk_action",
    "image_qa",
    "technical_qa",
  ],
  allowedRoles: ["primary", "review", "final"],
  canDraft: true,
  canReview: true,
  canFinal: true,
};

const profiles = [localDraft, apiGeneral, apiStrong];
const registry = new ModelRegistry(profiles);
const router = new SmartModelRouter(registry);

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("你好 → rule_only Level 0", () => {
  const d = router.route({ userInput: "你好" });
  assert.equal(d.executionStrategy, "rule_only");
  assert.equal(d.taskType, "casual_chat");
  assert.equal(d.selectedLevel, 0);
  assert.equal(d.selectedModelId, undefined);
});

test("记住我默认中文 → memory_write single_model", () => {
  const d = router.route({ userInput: "记住我默认用中文回答" });
  assert.equal(d.taskType, "memory_write");
  assert.equal(d.executionStrategy, "single_model");
});

test("TypeScript 报错 → single_model Level 2", () => {
  const d = router.route({ userInput: "解释这个 TypeScript 报错" });
  assert.equal(d.taskType, "debug");
  assert.equal(d.executionStrategy, "single_model");
  assert.ok(d.selectedModelId === "api-general" || d.selectedModelId === "api-strong");
});

test("完整架构方案 → local_draft_remote_review", () => {
  const d = router.route({ userInput: "帮我设计完整架构方案" });
  assert.equal(d.taskType, "architecture");
  assert.equal(d.executionStrategy, "local_draft_remote_review");
  assert.equal(d.draftModelId, "local-small");
  assert.ok(d.reviewModelId === "api-general" || d.reviewModelId === "api-strong");
});

test("实现文档 TodoList → 协作", () => {
  const d = router.route({ userInput: "写一份实现文档和 TodoList" });
  assert.equal(d.executionStrategy, "local_draft_remote_review");
});

test("图片附件 → single_model 且需 vision", () => {
  const rule = new RuleRouter().evaluate({
    userInput: "这张图是什么",
    hasAttachments: true,
    attachmentTypes: ["image"],
  });
  assert.equal(rule.requireVision, true);
  const engine = new DecisionEngine(registry);
  const d = engine.decide(rule, { userInput: "这张图是什么", hasAttachments: true, attachmentTypes: ["image"] });
  assert.equal(d.executionStrategy, "single_model");
  assert.equal(d.selectedModelId, "api-strong");
});

test("批量删除文件 → Level 3 且需确认", () => {
  const d = router.route({ userInput: "帮我批量删除这些文件" });
  assert.equal(d.taskType, "high_risk_action");
  assert.equal(d.selectedLevel, 3);
  assert.equal(d.requireUserConfirmation, true);
  assert.equal(d.executionStrategy, "single_model");
});

test("qualityMode=fast 禁用协作", () => {
  const d = router.route({
    userInput: "帮我设计完整架构方案",
    qualityMode: "fast",
  });
  assert.equal(d.executionStrategy, "single_model");
});

test("qualityMode=deep 倾向协作", () => {
  const d = router.route({
    userInput: "普通技术问题",
    qualityMode: "deep",
  });
  assert.equal(d.executionStrategy, "local_draft_remote_review");
});

test("validateModelProfiles 对完整配置无错误", () => {
  assert.deepEqual(validateModelProfiles(profiles), []);
});

test("validateModelProfiles 缺少 canFinal 时报错", () => {
  const bad = profiles.map((p) => ({ ...p, canFinal: false }));
  const errors = validateModelProfiles(bad);
  assert.ok(errors.some((e) => e.includes("canFinal")));
});

test("无 review 模型时文档协作降级 single_model", () => {
  const docLocal: ModelProfile = {
    ...localDraft,
    defaultLevel: 2,
    allowedTaskTypes: ["document_qa", "simple_qa"],
  };
  const localOnly = new ModelRegistry([docLocal]);
  const engine = new DecisionEngine(localOnly);
  const rule = new RuleRouter().evaluate({ userInput: "写一份实现文档" });
  const d = engine.decide(rule, { userInput: "文档", qualityMode: "balanced" });
  assert.equal(d.executionStrategy, "single_model");
  assert.ok(d.fallbackNote?.includes("无审查模型"));
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
console.log(`\nsmart-router: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
