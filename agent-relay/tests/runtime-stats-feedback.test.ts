/**
 * V8 RuntimeStats 只读反馈影响候选排序。
 * 运行：npm run test:runtime-stats-feedback
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { DecisionEngine } from "../src/model-router/decision-engine.js";
import { ModelRegistry } from "../src/model-router/model-registry.js";
import {
  ModelCallLogStore,
  RouteLogStore,
  ensureRoutingTables,
} from "../src/model-router/route-stores.js";
import { RuntimeStatsFeedback } from "../src/model-router/runtime-stats-feedback.js";
import { SmartModelRouter } from "../src/model-router/smart-model-router.js";
import type { ModelProfile } from "../src/model-router/types.js";

const db = new DatabaseSync(":memory:");
ensureRoutingTables(db);
const callStore = new ModelCallLogStore(db);
const routeStore = new RouteLogStore(db);

const localCheap: ModelProfile = {
  id: "local-cheap",
  displayName: "本地便宜",
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
  allowedTaskTypes: ["simple_qa", "technical_qa", "casual_chat"],
  allowedRoles: ["primary", "draft"],
  canDraft: true,
  canReview: false,
  canFinal: true,
};

const apiReliable: ModelProfile = {
  id: "api-reliable",
  displayName: "稳定 API",
  provider: "api",
  defaultLevel: 1,
  enabled: true,
  supportsStreaming: true,
  supportsTools: true,
  supportsVision: false,
  supportsJsonMode: true,
  maxInputTokens: 32000,
  maxOutputTokens: 4096,
  relativeCost: "medium",
  allowedTaskTypes: ["simple_qa", "technical_qa"],
  allowedRoles: ["primary", "review", "final"],
  canDraft: true,
  canReview: true,
  canFinal: true,
};

for (let i = 0; i < 4; i++) {
  callStore.create({
    routeLogId: "route-feedback",
    sessionId: "sess",
    modelId: "local-cheap",
    role: "primary",
    status: i < 3 ? "error" : "ok",
    durationMs: 50,
    promptTokens: 5,
    completionTokens: 2,
  });
}
callStore.create({
  routeLogId: "route-feedback",
  sessionId: "sess",
  modelId: "api-reliable",
  role: "primary",
  status: "ok",
  durationMs: 80,
  promptTokens: 5,
  completionTokens: 2,
});

const feedback = new RuntimeStatsFeedback(db);
const registry = new ModelRegistry([localCheap, apiReliable]);
const router = new SmartModelRouter(registry, routeStore, feedback);

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("rankCandidates 降权高错误率模型", () => {
  const ranked = feedback.rankCandidates([localCheap, apiReliable], "simple_qa");
  assert.equal(ranked.candidates[0]!.id, "api-reliable");
  assert.ok(ranked.signals.some((s) => s.startsWith("deprioritize:local-cheap")));
});

test("无 DB 时不改变候选顺序", () => {
  const noop = new RuntimeStatsFeedback();
  const ranked = noop.rankCandidates([localCheap, apiReliable]);
  assert.equal(ranked.candidates[0]!.id, "local-cheap");
  assert.equal(ranked.signals.length, 0);
});

test("Smart 路由 simple_qa 选用稳定模型且 source=runtime_stats", () => {
  const decision = router.route({
    userInput: "简单解释一下 HTTP 是什么",
    taskTypeOverride: "simple_qa",
    qualityMode: "balanced",
  });
  assert.equal(decision.taskType, "simple_qa");
  assert.equal(decision.selectedModelId, "api-reliable");
  assert.equal(decision.source, "runtime_stats");
  assert.match(decision.reason, /V8 运行反馈/);
  assert.ok(decision.contextSignals?.some((s) => s.startsWith("stats:deprioritize")));
});

test("DecisionEngine 无反馈时保持默认首选", () => {
  const singleRegistry = new ModelRegistry([localCheap]);
  const engine = new DecisionEngine(singleRegistry);
  const rule = {
    taskType: "casual_chat" as const,
    requiredLevel: 1 as const,
    risk: "low" as const,
    reason: "test",
    preferredStrategy: "single_model" as const,
    preferCollaboration: false,
  };
  const decision = engine.decide(rule, { userInput: "hello" });
  assert.equal(decision.selectedModelId, "local-cheap");
  assert.equal(decision.source, "rule");
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
console.log(`\nruntime-stats-feedback: ${passed}/${tests.length} passed`);
