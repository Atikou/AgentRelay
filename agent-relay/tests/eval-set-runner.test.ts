/**
 * V7 EvalSetRunner 离线评测与 model_eval_results 持久化。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_ROUTING_EVAL_SET,
  EvalSetRunner,
  ModelEvalStore,
  ModelRegistry,
  ensureEvalTables,
  type ModelProfile,
} from "../src/model-router/index.js";

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
  allowedTaskTypes: [
    "casual_chat",
    "simple_qa",
    "memory_write",
    "memory_search",
    "technical_qa",
    "architecture",
    "document_qa",
    "debug",
    "high_risk_action",
    "unknown",
  ],
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
  allowedTaskTypes: ["architecture", "document_qa", "technical_qa", "unknown", "high_risk_action"],
  allowedRoles: ["primary", "review", "final"],
  canDraft: false,
  canReview: true,
  canFinal: true,
};

const db = new DatabaseSync(":memory:");
ensureEvalTables(db);
const store = new ModelEvalStore(db);
const registry = new ModelRegistry([localDraft, apiStrong]);
const runner = new EvalSetRunner(registry, store);

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("默认评测集 rule 范围全部通过", () => {
  const summary = runner.run({ scope: "rule", setName: "builtin-rule" });
  assert.equal(summary.total, DEFAULT_ROUTING_EVAL_SET.length);
  assert.equal(summary.failed, 0, JSON.stringify(summary.results.filter((r) => r.verdict === "fail")));
  assert.ok(summary.passed >= 10);
});

test("smart 范围可跑 DecisionEngine 且不写 route_logs", () => {
  const summary = runner.run({ scope: "smart", setName: "builtin-smart", persist: false });
  assert.equal(summary.scope, "smart");
  assert.ok(summary.passed > 0);
  const routeCount = db
    .prepare(`SELECT COUNT(*) AS cnt FROM sqlite_master WHERE name='model_route_logs'`)
    .get() as { cnt: number };
  assert.equal(Number(routeCount.cnt), 0);
});

test("评测结果持久化到 model_eval_results", () => {
  const summary = runner.run({ scope: "rule", setName: "persist-test" });
  const detail = store.getRun(summary.runId);
  assert.ok(detail);
  assert.equal(detail.run.passed, summary.passed);
  assert.equal(detail.results.length, summary.total);
  const runs = store.listRuns(5);
  assert.ok(runs.some((r) => r.id === summary.runId));
});

test("无期望用例标记 skipped", () => {
  const summary = runner.run({
    scope: "rule",
    persist: false,
    cases: [{ id: "no-expect", title: "无期望", input: "测试输入" }],
  });
  assert.equal(summary.skipped, 1);
  assert.equal(summary.results[0]?.verdict, "skipped");
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
console.log(`\neval-set-runner: ${passed}/${tests.length} passed`);
