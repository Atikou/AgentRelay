/**
 * Level + Capability 分层路由自检。
 * Run: npm run test:model-capability-profile
 */
import assert from "node:assert/strict";

import { buildModelProfiles } from "../src/model-router/model-profiles.js";
import { ModelRegistry } from "../src/model-router/model-registry.js";
import {
  explainNoAvailableModel,
  profileHasDeclaredCapability,
  resolveTaskRequirement,
} from "../src/model-router/model-capability-profile.js";
import { withDeclaredCapabilities } from "../src/model-router/test-profile-helpers.js";
import type { RuleRouteResult } from "../src/model-router/types.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

const architectureRule: RuleRouteResult = {
  taskType: "architecture",
  requiredLevel: 3,
  risk: "medium",
  reason: "架构",
  requiredCapabilities: ["text", "code", "architecture"],
};

test("cloud-deepseek L3 声明 architecture 能力后可路由架构任务", () => {
  const profiles = buildModelProfiles([
    {
      name: "cloud-deepseek",
      provider: "openai-compatible",
      location: "remote",
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      model: "deepseek-chat",
      routerProfile: {
        defaultLevel: 3,
        relativeCost: "medium",
        canDraft: true,
        canReview: true,
        allowedRoles: ["primary", "draft", "review", "final"],
        capabilities: {
          text: true,
          code: true,
          architecture: true,
          toolCalling: true,
          jsonMode: true,
          longContext: true,
          image: false,
        },
      },
    },
    {
      name: "local-qwen35",
      provider: "ollama",
      location: "local",
      baseUrl: "http://localhost:11434",
      model: "qwen3.5:0.8b",
      routerProfile: { defaultLevel: 1, allowedRoles: ["primary", "draft"] },
    },
  ]);
  const deepseek = profiles.find((p) => p.id === "cloud-deepseek")!;
  assert.equal(deepseek.defaultLevel, 3);
  assert.equal(profileHasDeclaredCapability(deepseek, "architecture"), true);
  assert.equal(profileHasDeclaredCapability(deepseek, "image"), false);

  const registry = new ModelRegistry(profiles);
  const primary = registry.findPrimaryCandidates(architectureRule, false, {
    userInput: "分析 nextjs 项目架构",
  });
  assert.deepEqual(primary.map((p) => p.id), ["cloud-deepseek"]);
});

test("localOnly 时排除无 architecture 的 L1 本地模型", () => {
  const profiles = buildModelProfiles([
    {
      name: "local-qwen35",
      provider: "ollama",
      location: "local",
      baseUrl: "http://localhost:11434",
      model: "qwen3.5:0.8b",
      routerProfile: { defaultLevel: 1 },
    },
    {
      name: "local-phi4",
      provider: "ollama",
      location: "local",
      baseUrl: "http://localhost:11434",
      model: "phi4",
      routerProfile: {
        defaultLevel: 3,
        allowedRoles: ["primary", "draft", "review", "final"],
        capabilities: {
          text: true,
          code: true,
          architecture: true,
          toolCalling: true,
          jsonMode: true,
          longContext: true,
        },
      },
    },
  ]);
  const registry = new ModelRegistry(profiles);
  const primary = registry.findPrimaryCandidates(architectureRule, true, {
    userInput: "架构分析",
  });
  assert.deepEqual(primary.map((p) => p.id), ["local-phi4"]);
});

test("explainNoAvailableModel 指出缺失能力而非仅 Level", () => {
  const light = withDeclaredCapabilities({
    id: "local-small",
    displayName: "轻量",
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
    allowedTaskTypes: ["simple_qa"],
    allowedRoles: ["primary", "draft"],
    canDraft: true,
    canReview: false,
    canFinal: true,
  });
  const msg = explainNoAvailableModel(
    architectureRule,
    { userInput: "架构", localOnly: false },
    [light],
    [light],
  );
  assert.match(msg, /architecture|能力/);
});

test("resolveTaskRequirement 识别 UI 截图需求", () => {
  const req = resolveTaskRequirement(
    { taskType: "image_qa", requiredLevel: 2, risk: "low", reason: "图" },
    {
      userInput: "这个 UI 截图为什么显示不对",
      hasAttachments: true,
      attachmentTypes: ["image"],
    },
  );
  assert.ok(req.requiredCapabilities.includes("image"));
  assert.ok(req.requiredCapabilities.includes("uiScreenshot"));
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
