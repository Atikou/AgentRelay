/**
 * Level 0 rule_only：短问候规则直答，不调用模型。
 */
import assert from "node:assert/strict";

import { ModelOrchestrator } from "../src/model-orchestrator/model-orchestrator.js";
import { FallbackManager } from "../src/model-router/fallback-manager.js";
import { ModelRegistry } from "../src/model-router/model-registry.js";
import {
  isPureCasualGreeting,
  resolveRuleOnlyAnswer,
} from "../src/model-router/rule-only-responses.js";
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
  allowedTaskTypes: ["casual_chat", "simple_qa"],
  allowedRoles: ["primary"],
  canDraft: false,
  canReview: false,
  canFinal: true,
};

const registry = new ModelRegistry([localDraft]);
const router = new SmartModelRouter(registry);

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

test("isPureCasualGreeting 识别短问候", () => {
  assert.equal(isPureCasualGreeting("你好"), true);
  assert.equal(isPureCasualGreeting("hello!"), true);
  assert.equal(isPureCasualGreeting("闲聊一下今天天气"), false);
});

test("你好 → rule_only Level 0", () => {
  const d = router.route({ userInput: "你好" });
  assert.equal(d.executionStrategy, "rule_only");
  assert.equal(d.taskType, "casual_chat");
  assert.equal(d.selectedLevel, 0);
  assert.equal(d.selectedModelId, undefined);
  assert.deepEqual(d.candidates, []);
});

test("闲聊长句仍走 single_model", () => {
  const d = router.route({ userInput: "我们闲聊一下项目进展" });
  assert.equal(d.executionStrategy, "single_model");
  assert.equal(d.selectedLevel, 1);
});

test("resolveRuleOnlyAnswer 返回固定文案", () => {
  const answer = resolveRuleOnlyAnswer("casual_chat", "你好");
  assert.match(answer, /AgentRelay/);
});

test("ModelOrchestrator rule_only 不调用 chat", async () => {
  let chatCalls = 0;
  const orchestrator = new ModelOrchestrator(
    async () => {
      chatCalls += 1;
      throw new Error("不应调用模型");
    },
    { create: () => "collab-id" } as never,
    new FallbackManager(registry),
    { create: () => "fb-id" } as never,
  );
  const decision = router.route({ userInput: "谢谢" });
  const result = await orchestrator.run({
    routerDecision: decision,
    renderedPrompt: { systemSectionsText: "", finalMessages: [{ role: "user", content: "谢谢" }] },
    userInput: "谢谢",
  });
  assert.equal(result.usedStrategy, "rule_only");
  assert.equal(chatCalls, 0);
  assert.equal(result.usedModelIds.length, 0);
  assert.match(result.finalAnswer, /不客气/);
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ✓ ${t.name}`);
    passed += 1;
  } catch (error) {
    console.error(`  ✗ ${t.name}\n    ${String(error)}`);
    failed += 1;
  }
}
console.log(`\nrule-only: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
