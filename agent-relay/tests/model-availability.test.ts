/**
 * 模型可用性过滤自检（无需网络）。
 * 运行：npm run test:model-availability
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { createAgentChatFn } from "../src/model-router/create-smart-single-model-chat.js";
import { createModelChatFn } from "../src/model-router/create-model-chat.js";
import { ModelAvailabilityRegistry } from "../src/model-router/model-availability.js";
import { ModelRegistry } from "../src/model-router/model-registry.js";
import { ModelCallLogStore, ensureRoutingTables } from "../src/model-router/route-stores.js";
import { SmartModelRouter } from "../src/model-router/smart-model-router.js";
import type { ModelClient, ModelResponse } from "../src/model/types.js";
import type { ModelProfile } from "../src/model-router/types.js";

function profile(id: string, provider: "local" | "api"): ModelProfile {
  return {
    id,
    displayName: id,
    provider,
    defaultLevel: 2,
    enabled: true,
    supportsStreaming: true,
    supportsTools: provider === "api",
    supportsVision: false,
    supportsJsonMode: provider === "api",
    maxInputTokens: provider === "local" ? 8192 : 32000,
    maxOutputTokens: provider === "local" ? 2048 : 4096,
    relativeCost: provider === "local" ? "free" : "medium",
    allowedTaskTypes: ["casual_chat", "companion_chat", "simple_qa", "technical_qa", "unknown"],
    allowedRoles: ["primary", "draft", "review", "final"],
    canDraft: true,
    canReview: provider === "api",
    canFinal: true,
  };
}

function fakeClient(opts: {
  name: string;
  location: "local" | "remote";
  available: boolean;
  content?: string;
  calls: { chat: number; availability: number };
}): ModelClient {
  return {
    name: opts.name,
    model: opts.name,
    provider: opts.location === "local" ? "ollama" : "openai-compatible",
    location: opts.location,
    async isAvailable() {
      opts.calls.availability += 1;
      return opts.available;
    },
    async chat() {
      opts.calls.chat += 1;
      if (!opts.available) throw new Error(`model '${opts.name}' not found`);
      return {
        content: opts.content ?? "ok",
        toolCalls: [],
        clientName: opts.name,
        modelName: opts.name,
        location: opts.location,
        latencyMs: 1,
      } satisfies ModelResponse;
    },
  };
}

const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void) {
  tests.push({ name, fn });
}

test("Smart 单模型调用前预检不可用模型并重路由", async () => {
  const db = new DatabaseSync(":memory:");
  ensureRoutingTables(db);
  const availability = new ModelAvailabilityRegistry({ unavailableTtlMs: 60_000, probeTtlMs: 60_000 });
  const localCalls = { chat: 0, availability: 0 };
  const apiCalls = { chat: 0, availability: 0 };
  const clientMap = new Map<string, ModelClient>([
    ["local-bad", fakeClient({ name: "local-bad", location: "local", available: false, calls: localCalls })],
    ["api-good", fakeClient({ name: "api-good", location: "remote", available: true, calls: apiCalls, content: "fallback ok" })],
  ]);
  const registry = new ModelRegistry([profile("local-bad", "local"), profile("api-good", "api")], { availability });
  const smartRouter = new SmartModelRouter(registry);
  const modelChatFn = createModelChatFn(clientMap, new ModelCallLogStore(db), undefined, availability);
  const chat = createAgentChatFn({ smartRouter, modelChatFn });

  const response = await chat({ messages: [{ role: "user", content: "今天如何保持专注？" }] });

  assert.equal(response.clientName, "api-good");
  assert.equal(response.content, "fallback ok");
  assert.equal(localCalls.availability, 1);
  assert.equal(localCalls.chat, 0);
  assert.equal(apiCalls.chat, 1);
  assert.equal(availability.isAllowed("local-bad"), false);
  db.close();
});

test("ModelRegistry 过滤 availability 标记不可用的 profile", () => {
  const availability = new ModelAvailabilityRegistry();
  availability.markUnavailable("local-bad", "missing");
  const registry = new ModelRegistry([profile("local-bad", "local"), profile("api-good", "api")], { availability });
  const enabled = registry.listEnabled().map((p) => p.id);
  assert.deepEqual(enabled, ["api-good"]);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}
console.log(`\nmodel-availability: ${passed}/${tests.length} passed`);
