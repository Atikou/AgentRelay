/**
 * messageEnvelope 消息语义与 UI/上下文边界自检。
 * 运行：npx tsx tests/message-envelope.test.ts
 */
import assert from "node:assert/strict";

import {
  inferEnvelopeFromLegacy,
  isContextTrustedMessage,
  isUiChatBubble,
  resolveMessageEnvelope,
} from "../src/context/messageEnvelope.js";
import { buildGuardedFinalAnswer } from "../src/agent/completion/CompletionFinalGuard.js";
import { buildToolLedger } from "../src/agent/completion/ToolLedger.js";
import type { AgentToolStep } from "../src/agent/toolStep.js";
import { evaluateCompletionGuard } from "../src/agent/completion/CompletionFinalGuard.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("tool_action 不入 UI 气泡与 trusted 上下文", () => {
  const env = resolveMessageEnvelope({
    role: "assistant",
    messageKind: "tool_action",
    content: '{"action":"tool","tool":"shell_run"}',
  });
  assert.equal(env.uiVisible, false);
  assert.equal(env.trusted, false);
  assert.equal(isUiChatBubble(env, "assistant"), false);
  assert.equal(isContextTrustedMessage(env), false);
});

test("final_answer trusted 可入 UI 与上下文", () => {
  const env = resolveMessageEnvelope({
    role: "assistant",
    messageKind: "final_answer",
    trusted: true,
    source: "guard",
    content: "依赖尚未安装。",
  });
  assert.equal(isUiChatBubble(env, "assistant"), true);
  assert.equal(isContextTrustedMessage(env), true);
});

test("legacy JSON final 推断为 raw_model_final", () => {
  const env = inferEnvelopeFromLegacy(
    "assistant",
    JSON.stringify({ action: "final", answer: "已完成" }),
  );
  assert.equal(env.messageKind, "raw_model_final");
  assert.equal(env.uiVisible, false);
  assert.equal(isContextTrustedMessage(env), false);
});

test("Guard 拒绝时产生 guardedAnswer 且含事实说明", () => {
  const steps: AgentToolStep[] = [
    {
      iteration: 1,
      tool: "shell_run",
      input: { command: "npm install" },
      permission: "shell",
      blocked: true,
      executed: false,
      blockedReasonKind: "permission",
      outcomeKind: "permission_denied",
      ok: false,
      error: "权限策略要求确认",
    },
  ];
  const guard = evaluateCompletionGuard({
    goal: "安装依赖",
    intent: "run",
    mode: "implement",
    answer: "依赖安装已完成。",
    steps,
  });
  assert.equal(guard.accepted, false);
  assert.ok(guard.guardedAnswer);
  assert.match(guard.guardedAnswer!, /尚未|未授权|没有实际运行/);
  assert.equal(guard.rawModelAnswer, "依赖安装已完成。");
  assert.doesNotMatch(guard.guardedAnswer!, /依赖安装已完成/);
});

test("buildGuardedFinalAnswer shell 权限阻塞文案", () => {
  const ledger = buildToolLedger([]);
  const text = buildGuardedFinalAnswer({
    goal: "安装依赖",
    status: "awaiting_permission",
    reason: "shell 未授权",
    ledger,
    blockedSteps: [
      {
        iteration: 1,
        tool: "shell_run",
        input: { command: "npm install" },
        permission: "shell",
        blocked: true,
        ok: false,
      },
    ],
  });
  assert.match(text, /npm install/);
  assert.match(text, /没有实际运行/);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    throw error;
  }
}
console.log(`message-envelope: ${passed}/${tests.length} passed`);
