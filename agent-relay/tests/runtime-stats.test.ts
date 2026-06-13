/**
 * V6 RuntimeStats 聚合与只读建议。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { MetricsRegistry } from "../src/model/MetricsRegistry.js";
import {
  FallbackLogStore,
  ModelCallLogStore,
  RouteLogStore,
  ensureRoutingTables,
} from "../src/model-router/route-stores.js";
import { RuntimeStatsCollector } from "../src/model-router/runtime-stats.js";
import type { RouterDecision } from "../src/model-router/types.js";

const db = new DatabaseSync(":memory:");
ensureRoutingTables(db);

const routeStore = new RouteLogStore(db);
const callStore = new ModelCallLogStore(db);
const fallbackStore = new FallbackLogStore(db);

function saveRoute(id: string, taskType: RouterDecision["taskType"], source: RouterDecision["source"]) {
  const decision: RouterDecision = {
    id,
    sessionId: "sess-stats",
    taskType,
    selectedLevel: 2,
    risk: "medium",
    reason: "stats test",
    source,
    executionStrategy: "single_model",
    selectedModelId: "local-small",
    requireUserConfirmation: false,
    candidates: ["local-small", "api-strong"],
    createdAt: new Date().toISOString(),
  };
  routeStore.save(decision, `input-${id}`);
}

saveRoute("route-1", "architecture", "rule");
saveRoute("route-2", "architecture", "rule");
saveRoute("route-3", "unknown", "evaluator");
saveRoute("route-4", "unknown", "evaluator");
saveRoute("route-5", "unknown", "evaluator");

for (let i = 0; i < 4; i++) {
  callStore.create({
    routeLogId: "route-1",
    sessionId: "sess-stats",
    modelId: "local-small",
    role: "primary",
    status: i < 2 ? "ok" : "error",
    durationMs: 100 + i * 10,
    promptTokens: 10,
    completionTokens: 5,
  });
}
callStore.create({
  routeLogId: "route-2",
  sessionId: "sess-stats",
  modelId: "api-strong",
  role: "primary",
  status: "ok",
  durationMs: 200,
  promptTokens: 20,
  completionTokens: 10,
});

fallbackStore.create({
  routeLogId: "route-1",
  sessionId: "sess-stats",
  fromModelId: "local-small",
  toModelId: "api-strong",
  fromStrategy: "single_model",
  toStrategy: "strong_model_direct",
  triggerType: "answer_too_short",
  reason: "V4 评估：complex_answer_too_short",
});
fallbackStore.create({
  routeLogId: "route-2",
  sessionId: "sess-stats",
  fromModelId: "local-small",
  toModelId: "api-strong",
  fromStrategy: "single_model",
  toStrategy: "strong_model_direct",
  triggerType: "model_error",
  reason: "单模型失败",
});

const metrics = new MetricsRegistry();
metrics.record({
  clientName: "local-qwen",
  model: "qwen",
  location: "local",
  success: false,
  latencyMs: 1200,
  contextMessages: 2,
  error: "timeout",
});
metrics.record({
  clientName: "local-qwen",
  model: "qwen",
  location: "local",
  success: false,
  latencyMs: 900,
  contextMessages: 2,
  error: "timeout",
});
metrics.record({
  clientName: "local-qwen",
  model: "qwen",
  location: "local",
  success: true,
  latencyMs: 300,
  contextMessages: 2,
});

const collector = new RuntimeStatsCollector(db, metrics);

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("snapshot 聚合模型调用与 fallback 计数", () => {
  const snap = collector.snapshot({ routeLimit: 10 });
  const local = snap.models.find((m) => m.modelId === "local-small");
  assert.ok(local);
  assert.equal(local.calls, 4);
  assert.equal(local.errors, 2);
  assert.equal(local.errorRate, 0.5);
  assert.equal(local.fallbackFromCount, 2);
  assert.equal(snap.models.find((m) => m.modelId === "api-strong")?.fallbackToCount, 2);
});

test("snapshot 按 taskType 统计 fallback 与 evaluator", () => {
  const snap = collector.snapshot({ routeLimit: 10 });
  const arch = snap.taskTypes.find((t) => t.taskType === "architecture");
  const unknown = snap.taskTypes.find((t) => t.taskType === "unknown");
  assert.ok(arch);
  assert.equal(arch.routes, 2);
  assert.equal(arch.routesWithFallback, 2);
  assert.equal(arch.fallbackRate, 1);
  assert.ok(unknown);
  assert.equal(unknown.evaluatorRoutes, 3);
});

test("buildSuggestions 对高错误率模型与 unknown 评估给出建议", () => {
  const snap = collector.snapshot({ routeLimit: 10 });
  assert.ok(snap.suggestions.length > 0);
  assert.ok(snap.suggestions.some((s) => s.id === "model-error-local-small"));
  assert.ok(snap.suggestions.some((s) => s.id === "task-evaluator-unknown"));
  assert.ok(snap.suggestions.some((s) => s.category === "process_metrics"));
});

test("snapshot 合并进程内 MetricsRegistry", () => {
  const snap = collector.snapshot({ routeLimit: 5 });
  assert.equal(snap.processMetrics.length, 1);
  assert.equal(snap.processMetrics[0]?.clientName, "local-qwen");
  assert.equal(snap.summary.routeCount, 5);
});

let passed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`  ✓ ${t.name}`);
    passed += 1;
  } catch (error) {
    console.error(`  ✗ ${t.name}\n    ${String(error)}`);
    process.exitCode = 1;
    break;
  }
}
console.log(`\nruntime-stats: ${passed}/${tests.length} passed`);
