/**
 * Planner 经 SmartModelRouter + ModelRegistry 选模型。
 * 运行：npm run test:planner-router
 */
import assert from "node:assert/strict";

import { Planner } from "../src/agent/Planner.js";
import type { ModelClient, ModelResponse } from "../src/model/types.js";
import { ModelCallLogStore, ensureRoutingTables } from "../src/model-router/route-stores.js";
import {
  buildPlannerRouterInput,
  createPlannerChatFn,
  extractPlannerGoalFromMessages,
} from "../src/model-router/create-planner-chat.js";
import { ModelRegistry } from "../src/model-router/model-registry.js";
import { SmartModelRouter } from "../src/model-router/smart-model-router.js";
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
  allowedTaskTypes: ["casual_chat", "simple_qa", "technical_qa", "architecture", "document_qa"],
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
  allowedTaskTypes: ["architecture", "code_edit", "technical_qa", "high_risk_action"],
  allowedRoles: ["primary", "review", "final"],
  canDraft: true,
  canReview: true,
  canFinal: true,
};

const profiles = [localDraft, apiStrong];
const registry = new ModelRegistry(profiles);
const smartRouter = new SmartModelRouter(registry);

const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void) {
  tests.push({ name, fn });
}

test("extractPlannerGoalFromMessages 解析目标前缀", () => {
  const goal = extractPlannerGoalFromMessages([
    { role: "system", content: "sys" },
    { role: "user", content: "目标：实现登录模块\n\n相关上下文：\nREADME.md" },
  ]);
  assert.equal(goal, "实现登录模块");
});

test("buildPlannerRouterInput 强制单模型且 deep 质量", () => {
  const input = buildPlannerRouterInput("设计完整架构方案");
  assert.equal(input.qualityMode, "deep");
  assert.equal(input.forceSingleModel, true);
  assert.equal(input.allowCollaboration, false);
});

test("buildPlannerRouterInput sensitive 时 localOnly", () => {
  const input = buildPlannerRouterInput("任意目标", { sensitive: true });
  assert.equal(input.localOnly, true);
});

test("架构类计划经 Registry 选 Level 3 单模型", async () => {
  const called: string[] = [];
  const mockClient: ModelClient = {
    name: "api-strong",
    provider: "openai-compatible",
    location: "remote",
    model: "strong",
    async chat() {
      called.push("api-strong");
      return {
        clientName: "api-strong",
        modelName: "strong",
        location: "remote",
        content: JSON.stringify({
          goal: "g",
          steps: [
            { id: "s1", title: "a", description: "d", requiredPermissions: ["read"] },
            { id: "s2", title: "b", description: "d", requiredPermissions: ["read"] },
          ],
        }),
        latencyMs: 1,
      } satisfies ModelResponse;
    },
  };

  const chatFn = createPlannerChatFn({
    smartRouter,
    modelChatFn: async (modelId) => {
      called.push(modelId);
      assert.equal(modelId, "api-strong");
      const response = await mockClient.chat({ messages: [] });
      return { response, callLogId: "call-1" };
    },
  });

  const planner = new Planner(chatFn);
  const plan = await planner.generatePlan("帮我设计完整架构方案");
  assert.equal(plan.goal, "g");
  assert.equal(called[0], "api-strong");
});

test("localOnly 时 Planner 只选本地模型", async () => {
  let picked = "";
  const localStrong: ModelProfile = {
    ...localDraft,
    id: "local-strong",
    defaultLevel: 3,
    supportsJsonMode: true,
    allowedTaskTypes: ["architecture", "technical_qa", "document_qa"],
  };
  const localOnlyRouter = new SmartModelRouter(new ModelRegistry([localStrong, apiStrong]));
  const mockLocal: ModelClient = {
    name: "local-strong",
    provider: "ollama",
    location: "local",
    model: "local",
    async chat() {
      return {
        clientName: "local-strong",
        modelName: "local",
        location: "local",
        content: "{}",
        latencyMs: 1,
      } satisfies ModelResponse;
    },
  };

  const chatFn = createPlannerChatFn({
    smartRouter: localOnlyRouter,
    modelChatFn: async (modelId) => {
      picked = modelId;
      const response = await mockLocal.chat({ messages: [] });
      return { response, callLogId: "call-2" };
    },
  });

  await chatFn(
    { messages: [{ role: "user", content: "目标：帮我设计完整架构方案" }] },
    { sensitive: true },
  );
  assert.equal(picked, "local-strong");
});

test("ModelCallLogStore 记录 Planner 模型调用", async () => {
  const db = new (await import("node:sqlite")).DatabaseSync(":memory:");
  ensureRoutingTables(db);
  const callLogStore = new ModelCallLogStore(db);
  const { createModelChatFn } = await import("../src/model-router/create-model-chat.js");
  const clientMap = new Map<string, ModelClient>([
    [
      "api-strong",
      {
        name: "api-strong",
        provider: "openai-compatible",
        location: "remote",
        model: "strong",
        async chat() {
          return {
            clientName: "api-strong",
            modelName: "strong",
            location: "remote",
            content: "{}",
            latencyMs: 2,
          };
        },
      },
    ],
  ]);

  let routeLogId = "";
  const chatFn = createPlannerChatFn({
    smartRouter,
    modelChatFn: async (modelId, request, meta) => {
      routeLogId = meta.routeLogId ?? "";
      return createModelChatFn(clientMap, callLogStore)(modelId, request, meta);
    },
  });

  await chatFn({
    messages: [{ role: "user", content: "目标：设计完整架构方案" }],
  });

  assert.ok(routeLogId);
  const logs = callLogStore.listByRoute(routeLogId);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.modelId, "api-strong");
  assert.equal(logs[0]!.role, "primary");
  db.close();
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
console.log(`\nplanner-router: ${passed}/${tests.length} passed`);
