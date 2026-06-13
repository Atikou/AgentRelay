/**
 * ModelProfileStore（V8）自检。
 * 运行：npm run test:model-profile-store
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  ModelCallLogStore,
  ensureRoutingTables,
} from "../src/model-router/route-stores.js";
import { ModelProfileStore } from "../src/model-router/model-profile-store.js";
import type { ModelProfile } from "../src/model-router/types.js";

const localProfile: ModelProfile = {
  id: "local-small",
  displayName: "本地",
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
  allowedTaskTypes: ["simple_qa", "casual_chat"],
  allowedRoles: ["primary", "draft"],
  canDraft: true,
  canReview: false,
  canFinal: true,
};

const apiProfile: ModelProfile = {
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
  allowedTaskTypes: ["architecture", "technical_qa"],
  allowedRoles: ["primary", "review", "final"],
  canDraft: true,
  canReview: true,
  canFinal: true,
};

const db = new DatabaseSync(":memory:");
ensureRoutingTables(db);
const callStore = new ModelCallLogStore(db);
for (let i = 0; i < 3; i++) {
  callStore.create({
    routeLogId: "route-1",
    sessionId: "sess",
    modelId: "local-small",
    role: "primary",
    status: i === 0 ? "error" : "ok",
    durationMs: 10,
    promptTokens: 5,
    completionTokens: 2,
  });
}

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("snapshot 含能力矩阵与 validationErrors", () => {
  const store = new ModelProfileStore([localProfile, apiProfile]);
  const snap = store.snapshot();
  assert.ok(snap.profiles.length === 2);
  assert.ok(snap.matrix.length >= 10);
  assert.ok(Array.isArray(snap.coverage));
  assert.equal(snap.enabledCount, 2);
  assert.equal(snap.validationErrors.length, 0);
  assert.ok(snap.generatedAt);
});

test("无 DB 时 runtimeHintsByModelId 为空对象", () => {
  const store = new ModelProfileStore([localProfile]);
  const snap = store.snapshot();
  assert.deepEqual(snap.runtimeHintsByModelId, {});
});

test("有 DB 时 snapshot 附带运行指标", () => {
  const store = new ModelProfileStore([localProfile, apiProfile], { db });
  const snap = store.snapshot();
  const hint = snap.runtimeHintsByModelId["local-small"];
  assert.ok(hint);
  assert.equal(hint.calls, 3);
  assert.equal(hint.errors, 1);
  assert.ok(hint.errorRate > 0);
});

test("reloadFromClients 更新 registry 引用", () => {
  const store = new ModelProfileStore([localProfile]);
  const registryRef = store.registry;
  const errors = store.reloadFromClients([
    {
      name: "api-strong",
      provider: "openai-compatible",
      location: "remote",
      baseUrl: "http://localhost:9999/v1",
      model: "strong",
      routerProfile: { defaultLevel: 3, canReview: false, canDraft: true, canFinal: true },
    },
  ]);
  assert.equal(store.registry, registryRef);
  assert.equal(store.listAll().length, 1);
  assert.equal(store.get("api-strong")?.defaultLevel, 3);
  assert.ok(errors.some((e) => e.includes("canReview")));
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
console.log(`\nmodel-profile-store: ${passed}/${tests.length} passed`);
