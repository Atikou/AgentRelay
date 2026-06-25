/**
 * AIIntentClassifier 自检（mock chat，不依赖真实模型）。
 * 运行：npm run test:ai-intent-classifier
 */
import assert from "node:assert/strict";

import {
  classifyIntentWithAIAsync,
  recordIntentClassifierDiff,
  wireAIIntentClassifier,
} from "../src/agent/routing/AIIntentClassifier.js";
import { EntryIntentRouter } from "../src/agent/routing/EntryIntentRouter.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("高置信 AI 决策覆盖 legacy", async () => {
  wireAIIntentClassifier(async () =>
    JSON.stringify({
      intent: "debug",
      isContinuation: true,
      isNewTask: false,
      confidence: 0.92,
    }),
  );
  const router = new EntryIntentRouter();
  const decision = await router.resolveAsync({
    message: "找不到 localhost 的网页 http://localhost:36970/",
  });
  assert.equal(decision.source, "ai_classifier");
  assert.equal(decision.intent, "debug");
  wireAIIntentClassifier(null);
});

test("低置信或解析失败回退 legacy", async () => {
  wireAIIntentClassifier(async () => "not json");
  const router = new EntryIntentRouter();
  const decision = await router.resolveAsync({ message: "你好" });
  assert.equal(decision.source, "legacy_fallback");
  assert.equal(decision.intent, "answer");
  wireAIIntentClassifier(null);
});

test("recordIntentClassifierDiff 记录 AI 与 legacy 差异", async () => {
  wireAIIntentClassifier(async () =>
    JSON.stringify({
      intent: "debug",
      isContinuation: true,
      isNewTask: false,
      confidence: 0.9,
    }),
  );
  await classifyIntentWithAIAsync({ message: "localhost error" });
  recordIntentClassifierDiff({
    message: "localhost error",
    aiDecision: {
      mode: "debug",
      modeSource: "inferred",
      intent: "debug",
      workflowType: "debugWorkflow",
      workflowPlan: null,
      isContinuation: true,
      isNewTask: false,
      confidence: 0.9,
      reason: "ai",
      source: "ai_classifier",
    },
    legacyIntent: "answer",
  });
  wireAIIntentClassifier(null);
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(error);
  }
}
console.log(`\nai-intent-classifier: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
