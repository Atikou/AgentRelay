/**
 * ContextAnalyzer（V8 P0）自检。
 * 运行：npm run test:context-analyzer
 */
import assert from "node:assert/strict";

import {
  ContextAnalyzer,
  applyRoutingContext,
} from "../src/model-router/context-analyzer.js";
import type { RuleRouteResult } from "../src/model-router/types.js";

const analyzer = new ContextAnalyzer();

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("长上下文产生 high pressure 与 level_bump", () => {
  const ctx = analyzer.analyze({
    userInput: "根据附件回答",
    contextTokenEstimate: 50_000,
  });
  assert.equal(ctx.contextPressure, "high");
  assert.equal(ctx.suggestedLevelBump, 1);
  assert.ok(ctx.signals.includes("level_bump+1"));
});

test("架构 + deep 建议协作", () => {
  const ctx = analyzer.analyze({
    userInput: "设计完整架构方案与模块边界",
    qualityMode: "deep",
    allowCollaboration: true,
  });
  assert.equal(ctx.suggestsCollaboration, true);
  assert.ok(ctx.signals.includes("suggest_collaboration"));
});

test("applyRoutingContext 提升 requiredLevel", () => {
  const rule: RuleRouteResult = {
    taskType: "simple_qa",
    requiredLevel: 1,
    risk: "low",
    reason: "test",
    preferredStrategy: "single_model",
  };
  const adjusted = applyRoutingContext(rule, {
    complexity: "high",
    contextPressure: "high",
    effectiveTokenEstimate: 60_000,
    suggestedLevelBump: 1,
    suggestsCollaboration: false,
    hasCodeIntent: false,
    hasToolIntent: false,
    signals: ["level_bump+1"],
  });
  assert.equal(adjusted.requiredLevel, 2);
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`  ok ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(error);
  }
}
console.log(`\ncontext-analyzer: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
