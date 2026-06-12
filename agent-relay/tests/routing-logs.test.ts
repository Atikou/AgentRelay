/**
 * 路由日志 Store 与查询结构。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  CollaborationRunStore,
  FallbackLogStore,
  ModelCallLogStore,
  RouteLogStore,
  ensureRoutingTables,
} from "../src/model-router/route-stores.js";
import type { RouterDecision } from "../src/model-router/types.js";

const db = new DatabaseSync(":memory:");
ensureRoutingTables(db);

const routeStore = new RouteLogStore(db);
const callStore = new ModelCallLogStore(db);
const collabStore = new CollaborationRunStore(db);
const fallbackStore = new FallbackLogStore(db);

const decision: RouterDecision = {
  id: "route-test-1",
  sessionId: "sess-1",
  taskType: "simple_qa",
  selectedLevel: 1,
  risk: "low",
  reason: "测试",
  source: "rule",
  executionStrategy: "single_model",
  selectedModelId: "local-small",
  requireUserConfirmation: false,
  candidates: ["local-small"],
  createdAt: new Date().toISOString(),
};

routeStore.save(decision, "你好");
callStore.create({
  routeLogId: decision.id,
  sessionId: "sess-1",
  modelId: "local-small",
  role: "primary",
  status: "ok",
});
const collabId = collabStore.create({
  routeLogId: decision.id,
  sessionId: "sess-1",
  strategy: "single_model",
  draftModelId: "local-small",
});
collabStore.finish(collabId, { status: "completed", verdict: "approve" });
fallbackStore.create({
  routeLogId: decision.id,
  sessionId: "sess-1",
  fromModelId: "local-small",
  toModelId: "api-strong",
  fromStrategy: "single_model",
  toStrategy: "strong_model_direct",
  triggerType: "model_error",
  reason: "测试 fallback",
});

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("RouteLogStore.listRecent 按 session 过滤", () => {
  const rows = routeStore.listRecent(10, "sess-1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.executionStrategy, "single_model");
});

test("RouteLogStore.get 返回完整路由记录", () => {
  const row = routeStore.get("route-test-1");
  assert.ok(row);
  assert.equal(row.reason, "测试");
});

test("关联查询 calls / collaborations / fallbacks", () => {
  assert.equal(callStore.listByRoute("route-test-1").length, 1);
  assert.equal(collabStore.listByRoute("route-test-1").length, 1);
  assert.equal(fallbackStore.listByRoute("route-test-1").length, 1);
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
console.log(`\nrouting-logs: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
