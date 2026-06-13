/**
 * V4 AnswerEvaluator 运行时：复杂任务过短答案触发 ModelOrchestrator fallback。
 */
import assert from "node:assert/strict";

import { ModelOrchestrator } from "../src/model-orchestrator/model-orchestrator.js";
import { FallbackManager } from "../src/model-router/fallback-manager.js";
import { ModelRegistry } from "../src/model-router/model-registry.js";
import type { FallbackLogStore } from "../src/model-router/route-stores.js";
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
  allowedTaskTypes: ["architecture", "document_qa", "technical_qa"],
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
  allowedTaskTypes: ["architecture", "document_qa", "technical_qa"],
  allowedRoles: ["primary", "review", "final"],
  canDraft: false,
  canReview: true,
  canFinal: true,
};

const registry = new ModelRegistry([localDraft, apiStrong]);
const fallbackManager = new FallbackManager(registry);

const decision: RouterDecision = {
  id: "route-v4-test",
  taskType: "architecture",
  selectedLevel: 2,
  risk: "medium",
  reason: "架构任务",
  source: "rule",
  executionStrategy: "single_model",
  selectedModelId: "local-small",
  requireUserConfirmation: false,
  candidates: ["local-small", "api-strong"],
  createdAt: new Date().toISOString(),
};

const longAnswer =
  "这是一个足够长的架构说明，包含模块边界、调用链路、风险控制、验证方式和后续演进建议，能够满足当前规则版评估的最小长度要求。它还会说明数据持久化、安全审计、模型 fallback 与测试策略之间的关系。";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("过短答案触发 V4 fallback 并升级模型", async () => {
  let chatCalls = 0;
  const fallbackLogs: Array<{ triggerType: string; reason: string }> = [];
  const fallbackLogStore: Pick<FallbackLogStore, "create"> = {
    create: (input) => {
      fallbackLogs.push({ triggerType: input.triggerType, reason: input.reason });
      return `fb-${fallbackLogs.length}`;
    },
  };

  const orchestrator = new ModelOrchestrator(
    async () => {
      chatCalls += 1;
      return {
        response: {
          content: chatCalls === 1 ? "太短" : longAnswer,
          clientName: chatCalls === 1 ? "local-small" : "api-strong",
          modelName: "test",
          location: chatCalls === 1 ? "local" : "remote",
          latencyMs: 1,
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        callLogId: `call-${chatCalls}`,
      };
    },
    { create: () => "collab-id" } as never,
    fallbackManager,
    fallbackLogStore as FallbackLogStore,
  );

  const result = await orchestrator.run({
    routerDecision: decision,
    renderedPrompt: {
      systemSectionsText: "",
      finalMessages: [{ role: "user", content: "请设计完整架构方案并说明模块边界" }],
    },
    userInput: "请设计完整架构方案并说明模块边界",
  });

  assert.equal(chatCalls, 2);
  assert.equal(result.fallbackCount, 1);
  assert.deepEqual(result.usedModelIds, ["api-strong"]);
  assert.equal(result.finalAnswer, longAnswer);
  assert.equal(fallbackLogs.length, 1);
  assert.equal(fallbackLogs[0]!.triggerType, "answer_too_short");
  assert.match(fallbackLogs[0]!.reason, /V4 评估/);
});

test("足够长的答案不触发 V4 fallback", async () => {
  let chatCalls = 0;
  const orchestrator = new ModelOrchestrator(
    async () => {
      chatCalls += 1;
      return {
        response: {
          content: longAnswer,
          clientName: "local-small",
          modelName: "test",
          location: "local",
          latencyMs: 1,
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        callLogId: "call-1",
      };
    },
    { create: () => "collab-id" } as never,
    fallbackManager,
    { create: () => "fb-id" } as never,
  );

  const result = await orchestrator.run({
    routerDecision: decision,
    renderedPrompt: {
      systemSectionsText: "",
      finalMessages: [{ role: "user", content: "请设计完整架构方案" }],
    },
    userInput: "请设计完整架构方案",
  });

  assert.equal(chatCalls, 1);
  assert.equal(result.fallbackCount, undefined);
  assert.deepEqual(result.usedModelIds, ["local-small"]);
});

async function main() {
  for (const t of tests) {
    await t.fn();
    console.log(`  ✓ ${t.name}`);
  }
  console.log(`\nanswer-evaluator-orchestrator: ${tests.length} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
