/**
 * Agent 默认经 SmartModelRouter 选模型。
 * 运行：npm run test:agent-smart-router
 */
import assert from "node:assert/strict";

import type { ModelClient, ModelResponse } from "../src/model/types.js";
import {
  buildAgentRouterInput,
  createAgentChatFn,
  extractLastUserMessage,
} from "../src/model-router/create-smart-single-model-chat.js";
import { ModelRegistry } from "../src/model-router/model-registry.js";
import { SmartModelRouter } from "../src/model-router/smart-model-router.js";
import type { ModelProfile } from "../src/model-router/types.js";

const localSmall: ModelProfile = {
  id: "local-small",
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
  allowedTaskTypes: ["casual_chat", "simple_qa", "technical_qa", "code_question", "debug"],
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
  supportsVision: false,
  supportsJsonMode: true,
  maxInputTokens: 128000,
  maxOutputTokens: 8192,
  relativeCost: "high",
  allowedTaskTypes: ["architecture", "code_edit", "debug", "technical_qa"],
  allowedRoles: ["primary", "review", "final"],
  canDraft: true,
  canReview: true,
  canFinal: true,
};

const smartRouter = new SmartModelRouter(new ModelRegistry([localSmall, apiStrong]));

const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void) {
  tests.push({ name, fn });
}

test("extractLastUserMessage 取最近 user", () => {
  assert.equal(
    extractLastUserMessage([
      { role: "system", content: "s" },
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
    ]),
    "second",
  );
});

test("buildAgentRouterInput 强制单模型", () => {
  const input = buildAgentRouterInput("解释 TypeScript 报错", { taskType: "reasoning" });
  assert.equal(input.forceSingleModel, true);
  assert.equal(input.allowCollaboration, false);
  assert.equal(input.taskTypeOverride, "architecture");
});

test("Agent chat 经 Registry 选 debug 模型", async () => {
  let picked = "";
  const chatFn = createAgentChatFn({
    smartRouter,
    modelChatFn: async (modelId) => {
      picked = modelId;
      return {
        response: {
          clientName: modelId,
          modelName: modelId,
          location: "remote",
          content: "{}",
          latencyMs: 1,
        } satisfies ModelResponse,
        callLogId: "c1",
      };
    },
  });

  await chatFn(
    { messages: [{ role: "user", content: "解释这个 TypeScript 报错" }] },
    { taskType: "codegen" },
  );
  assert.ok(picked === "api-strong" || picked === "local-small");
});

test("sensitive 时 Agent chat 只选本地", async () => {
  let picked = "";
  const chatFn = createAgentChatFn({
    smartRouter,
    modelChatFn: async (modelId) => {
      picked = modelId;
      return {
        response: {
          clientName: modelId,
          modelName: modelId,
          location: "local",
          content: "ok",
          latencyMs: 1,
        } satisfies ModelResponse,
        callLogId: "c2",
      };
    },
  });

  await chatFn(
    { messages: [{ role: "user", content: "HTTP 404 是什么" }] },
    { sensitive: true, taskType: "simple" },
  );
  assert.equal(picked, "local-small");
});

test("短问候走 rule_only 且不调用模型", async () => {
  let called = false;
  const chatFn = createAgentChatFn({
    smartRouter,
    modelChatFn: async () => {
      called = true;
      throw new Error("rule_only 不应调用模型");
    },
  });

  const response = await chatFn(
    { messages: [{ role: "user", content: "你好" }] },
    { sensitive: true },
  );
  assert.equal(called, false);
  assert.equal(response.clientName, "rule-only");
  assert.match(response.content, /你好|AgentRelay/);
});

let passed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed++;
    console.log(`  ✓ ${t.name}`);
  } catch (error) {
    console.error(`  ✗ ${t.name}`);
    throw error;
  }
}
console.log(`\nagent-smart-router: ${passed}/${tests.length} passed`);
