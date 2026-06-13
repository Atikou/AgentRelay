/**
 * V2 FallbackManager 验收测试（对照 docs/模型路由升级TodoList.md §需要验证的测试）。
 * 运行：npm run test:fallback-verification
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { ModelOrchestrator } from "../src/model-orchestrator/model-orchestrator.js";
import {
  FallbackManager,
  MAX_FALLBACKS_PER_REQUEST,
} from "../src/model-router/fallback-manager.js";
import { ModelRegistry } from "../src/model-router/model-registry.js";
import {
  CollaborationRunStore,
  FallbackLogStore,
  ensureRoutingTables,
} from "../src/model-router/route-stores.js";
import type { ModelProfile, RouterDecision } from "../src/model-router/types.js";
import type { ModelResponse } from "../src/model/types.js";

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
  allowedTaskTypes: ["architecture", "document_qa", "technical_qa", "simple_qa"],
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
  allowedTaskTypes: ["architecture", "document_qa", "technical_qa", "simple_qa"],
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
  allowedTaskTypes: ["architecture", "document_qa", "technical_qa", "simple_qa"],
  allowedRoles: ["primary", "review", "final"],
  canDraft: false,
  canReview: true,
  canFinal: true,
};

const registry = new ModelRegistry([localDraft, apiGeneral, apiStrong]);
const fallbackManager = new FallbackManager(registry);

const routeId = "route-v2-verify";

const baseDecision: RouterDecision = {
  id: routeId,
  sessionId: "sess-v2",
  taskType: "technical_qa",
  selectedLevel: 1,
  risk: "medium",
  reason: "V2 验收",
  source: "rule",
  executionStrategy: "single_model",
  selectedModelId: "local-small",
  requireUserConfirmation: false,
  candidates: ["local-small", "api-general", "api-strong"],
  createdAt: new Date().toISOString(),
};

function mockResponse(content: string, modelId: string): ModelResponse {
  return {
    content,
    toolCalls: [],
    clientName: modelId,
    modelName: "mock",
    location: modelId === "local-small" ? "local" : "remote",
    latencyMs: 5,
    usage: { inputTokens: 10, outputTokens: 20 },
  };
}

const longAnswer =
  "完整架构说明：模块边界、调用链路、数据持久化、安全审计、模型 fallback 与测试策略均已覆盖，满足规则版答案长度要求。";

function makeStores() {
  const db = new DatabaseSync(":memory:");
  ensureRoutingTables(db);
  return {
    collab: new CollaborationRunStore(db),
    fallback: new FallbackLogStore(db),
  };
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("L1 model_error 升级到 L2 且只返回一条 finalAnswer", async () => {
  const { collab, fallback } = makeStores();
  const calls: string[] = [];
  const orchestrator = new ModelOrchestrator(
    async (modelId) => {
      calls.push(modelId);
      if (modelId === "local-small") {
        throw new Error("timeout simulated");
      }
      return { response: mockResponse(longAnswer, modelId), callLogId: `log-${calls.length}` };
    },
    collab,
    fallbackManager,
    fallback,
  );

  const result = await orchestrator.run({
    routerDecision: baseDecision,
    sessionId: "sess-v2",
    renderedPrompt: {
      systemSectionsText: "",
      finalMessages: [{ role: "user", content: "设计架构" }],
    },
    userInput: "设计架构",
  });

  assert.deepEqual(calls, ["local-small", "api-general"]);
  assert.equal(result.finalAnswer, longAnswer);
  assert.equal(result.fallbackCount, 1);
  assert.deepEqual(result.usedModelIds, ["api-general"]);
  assert.equal(result.usedStrategy, "single_model");
});

test("L2 失败后继续升级到 L3 strong_model_direct", async () => {
  const { collab, fallback } = makeStores();
  const calls: string[] = [];
  const orchestrator = new ModelOrchestrator(
    async (modelId) => {
      calls.push(modelId);
      if (modelId !== "api-strong") {
        throw new Error(`fail ${modelId}`);
      }
      return { response: mockResponse(longAnswer, modelId), callLogId: `log-${calls.length}` };
    },
    collab,
    fallbackManager,
    fallback,
  );

  const result = await orchestrator.run({
    routerDecision: baseDecision,
    sessionId: "sess-v2",
    renderedPrompt: {
      systemSectionsText: "",
      finalMessages: [{ role: "user", content: "设计架构" }],
    },
    userInput: "设计架构",
  });

  assert.deepEqual(calls, ["local-small", "api-general", "api-strong"]);
  assert.equal(result.fallbackCount, 2);
  assert.equal(result.usedStrategy, "strong_model_direct");
  assert.deepEqual(result.usedModelIds, ["api-strong"]);
});

test("fallback 达上限后 model_error 抛错且不返回半成品", async () => {
  const { collab, fallback } = makeStores();
  const orchestrator = new ModelOrchestrator(
    async () => {
      throw new Error("persistent failure");
    },
    collab,
    fallbackManager,
    fallback,
  );

  await assert.rejects(
    () =>
      orchestrator.run({
        routerDecision: baseDecision,
        sessionId: "sess-v2",
        renderedPrompt: {
          systemSectionsText: "",
          finalMessages: [{ role: "user", content: "设计架构" }],
        },
        userInput: "设计架构",
      }),
    /persistent failure/,
  );

  const logs = fallback.listByRoute(routeId);
  assert.equal(logs.length, MAX_FALLBACKS_PER_REQUEST);
});

test("fallback_logs 通过 routeLogId 与路由记录关联", async () => {
  const { collab, fallback } = makeStores();
  let chatCalls = 0;
  const orchestrator = new ModelOrchestrator(
    async (modelId) => {
      chatCalls += 1;
      if (chatCalls === 1) {
        throw new Error("first fail");
      }
      return { response: mockResponse(longAnswer, modelId), callLogId: `log-${chatCalls}` };
    },
    collab,
    fallbackManager,
    fallback,
  );

  const result = await orchestrator.run({
    routerDecision: baseDecision,
    sessionId: "sess-v2",
    renderedPrompt: {
      systemSectionsText: "",
      finalMessages: [{ role: "user", content: "设计架构" }],
    },
    userInput: "设计架构",
  });

  assert.equal(result.fallbackLogIds?.length, 1);
  const logs = fallback.listByRoute(routeId);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.routeLogId, routeId);
  assert.equal(logs[0]?.fromModelId, "local-small");
  assert.equal(logs[0]?.toModelId, "api-general");
  assert.equal(logs[0]?.triggerType, "model_error");
});

test("model_timeout 触发与 model_error 相同的升级路径", () => {
  const plan = fallbackManager.plan(baseDecision, "model_timeout", { fromModelId: "local-small" });
  assert.ok(plan);
  assert.equal(plan.toModelId, "api-general");
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${String(error)}`);
    throw error;
  }
}
console.log(`\nfallback-verification: ${passed}/${tests.length} passed`);
