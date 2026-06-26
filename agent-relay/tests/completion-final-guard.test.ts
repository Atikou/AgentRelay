/**
 * CompletionFinalGuard 副作用任务虚假完成防护自检。
 * 运行：npx tsx tests/completion-final-guard.test.ts
 */
import assert from "node:assert/strict";

import { buildTaskCompletionContract } from "../src/agent/completion/TaskCompletionContract.js";
import { buildToolLedger } from "../src/agent/completion/ToolLedger.js";
import { evaluateCompletionGuard } from "../src/agent/completion/CompletionFinalGuard.js";
import type { AgentToolStep } from "../src/agent/toolStep.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("安装依赖需要 shell 副作用", () => {
  const contract = buildTaskCompletionContract({
    goal: "安装依赖",
    intent: "run",
    mode: "implement",
  });
  assert.equal(contract.requiresSideEffect, true);
  assert.ok(contract.requiredSideEffects.includes("shell"));
});

test("问答任务不需要副作用", () => {
  const contract = buildTaskCompletionContract({
    goal: "依赖是全局还是项目",
    intent: "answer",
    mode: "chat",
  });
  assert.equal(contract.requiresSideEffect, false);
});

test("基于历史说明先前已安装但 ledger 为空 → historical_reference，不接受 trusted", () => {
  const guard = evaluateCompletionGuard({
    goal: "安装依赖",
    intent: "run",
    mode: "implement",
    answer:
      "根据历史记录，`testTS` 项目的依赖安装已在之前成功完成。执行 `npm install` 后安装了 three 与 typescript。当前依赖已就绪，无需额外操作。",
    steps: [],
  });
  assert.equal(guard.accepted, false);
  assert.equal(guard.status, "historical_reference");
  assert.equal(guard.stopReason, "completed_partial");
  assert.ok(guard.guardedAnswer);
  assert.ok(guard.rawModelAnswer?.includes("根据历史"));
});

test("shell 被权限阻止且模型声称本轮已成功 → guardedAnswer 替代 raw final", () => {
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
      error: "权限策略 confirmBeforeEdit 要求确认执行操作",
    },
  ];
  const ledger = buildToolLedger(steps);
  assert.equal(ledger.blockedShellCalls, 1);
  assert.equal(ledger.successfulShellCalls, 0);

  const guard = evaluateCompletionGuard({
    goal: "安装依赖",
    intent: "run",
    mode: "implement",
    answer: "依赖已成功安装，npm install 完成。",
    steps,
  });
  assert.equal(guard.accepted, false);
  assert.equal(guard.status, "awaiting_permission");
  assert.equal(guard.stopReason, "awaiting_permission");
  assert.ok(guard.guardedAnswer);
  assert.match(guard.guardedAnswer!, /没有实际运行|未授权/);
  assert.equal(guard.rawModelAnswer, "依赖已成功安装，npm install 完成。");
  assert.doesNotMatch(guard.guardedAnswer!, /已成功安装/);
});

test("零副作用但模型声称本轮已完成 → misleading_completion + guardedAnswer", () => {
  const guard = evaluateCompletionGuard({
    goal: "执行增强方案",
    intent: "edit",
    mode: "implement",
    answer: "增强方案已执行完成，文件已修改。",
    steps: [],
  });
  assert.equal(guard.accepted, false);
  assert.equal(guard.status, "misleading_completion");
  assert.ok(guard.guardedAnswer);
  assert.match(guard.guardedAnswer!, /尚未真实完成/);
  assert.doesNotMatch(guard.guardedAnswer!, /已执行完成/);
});

test("shell 成功执行 → completed_success 且接受模型 final", () => {
  const steps: AgentToolStep[] = [
    {
      iteration: 1,
      tool: "shell_run",
      input: { command: "npm install" },
      permission: "shell",
      outcomeClass: "observation_success",
      ok: true,
      executed: true,
    },
  ];
  const guard = evaluateCompletionGuard({
    goal: "安装依赖",
    intent: "run",
    mode: "implement",
    answer: "依赖安装完成。",
    steps,
  });
  assert.equal(guard.accepted, true);
  assert.equal(guard.status, "completed_success");
  assert.equal(guard.stopReason, "completed");
  assert.equal(guard.guardedAnswer, undefined);
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
console.log(`completion-final-guard: ${passed}/${tests.length} passed`);
