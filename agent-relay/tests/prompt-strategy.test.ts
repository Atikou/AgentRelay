/**
 * PromptStrategyBuilder（V8）自检。
 * 运行：npm run test:prompt-strategy
 */
import assert from "node:assert/strict";

import { defaultPromptStrategyBuilder } from "../src/model-router/prompt-strategy-builder.js";
import type { RouterDecision } from "../src/model-router/types.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

function baseDecision(overrides: Partial<RouterDecision> = {}): RouterDecision {
  return {
    id: "d1",
    taskType: "simple_qa",
    selectedLevel: 1,
    risk: "low",
    reason: "test",
    source: "rule",
    executionStrategy: "single_model",
    selectedModelId: "local-small",
    requireUserConfirmation: false,
    candidates: ["local-small"],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test("fast 质量生成 concise 策略与较低 temperature", () => {
  const strategy = defaultPromptStrategyBuilder.build({
    decision: baseDecision(),
    userInput: "你好",
    qualityMode: "fast",
  });
  assert.equal(strategy.responseStyle, "concise");
  assert.equal(strategy.temperature, 0.2);
  assert.match(strategy.systemAddendum, /简洁/);
});

test("架构 deep 任务生成 detailed 策略", () => {
  const strategy = defaultPromptStrategyBuilder.build({
    decision: baseDecision({
      taskType: "architecture",
      executionStrategy: "local_draft_remote_review",
      draftModelId: "local-small",
      reviewModelId: "api-strong",
    }),
    userInput: "设计完整架构方案",
    qualityMode: "deep",
  });
  assert.equal(strategy.responseStyle, "detailed");
  assert.equal(strategy.temperature, 0.2);
  assert.equal(strategy.preferJsonMode, true);
  assert.match(strategy.systemAddendum, /结构化/);
});

test("高风险任务追加确认提示", () => {
  const strategy = defaultPromptStrategyBuilder.build({
    decision: baseDecision({
      taskType: "high_risk_action",
      risk: "high",
      selectedLevel: 3,
    }),
    userInput: "批量删除文件",
    qualityMode: "balanced",
  });
  assert.match(strategy.systemAddendum, /高风险/);
  assert.ok(strategy.hints.includes("risk=high"));
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
console.log(`\nprompt-strategy: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
