/**
 * 全链路架构审查对抗性自检矩阵。
 * 运行：npm run test:architecture-audit
 */
import assert from "node:assert/strict";

import { resolveLegacyIntentFallback } from "../src/agent/routing/LegacyIntentFallback.js";
import { extractLegacyIntentHints } from "../src/agent/routing/LegacyIntentHints.js";
import { RunPolicyManager } from "../src/agent/RunPolicyManager.js";
import { BudgetManager } from "../src/agent/BudgetManager.js";
import { scrubStructuredSummaryContent } from "../src/context/contextTrust.js";
import { presentExecutionState } from "../src/agent/presentation/ExecutionStatePresenter.js";
import { evaluateCompletionGuard } from "../src/agent/completion/CompletionFinalGuard.js";
import { buildIntentClassifierUserMessage } from "../src/agent/routing/intentClassifierPrompt.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("D1 legacy 关键词仅作 hint，最终 intent 为中性 answer", () => {
  const message = "请执行 npm install 安装项目依赖";
  const hints = extractLegacyIntentHints(message);
  assert.equal(hints.hintedIntent, "run");
  assert.ok(hints.hintSources.some((s) => s.includes("keyword") || s.includes("unicode")));
  const decision = resolveLegacyIntentFallback({ message });
  assert.equal(decision.intent, "answer");
  assert.equal(decision.legacyIntentHint, "run");
  assert.equal(decision.source, "legacy_fallback");
});

test("C4 chunk_summary scrub 移除未验证完成声明", () => {
  const scrubbed = scrubStructuredSummaryContent({
    current_goal: "修改配置",
    important_decisions: ["依赖安装已完成", "采用 vite 配置"],
    project_state: [],
  });
  assert.equal(scrubbed.important_decisions?.length, 1);
  assert.ok(scrubbed.important_decisions?.[0]?.includes("vite"));
});

test("C5 recovery 步不计入主 maxToolCalls", () => {
  const budget = {
    maxModelTurns: 5,
    maxToolCalls: 2,
    maxReadCalls: 10,
    maxWriteCalls: 5,
    maxShellCalls: 5,
    maxPreflightTools: 5,
    maxRecoveryTurns: 3,
    maxRepeatedToolFailures: 3,
    maxRuntimeMs: 600_000,
  };
  const bm = new BudgetManager(budget, { ...budget, maxToolCalls: 10 });
  bm.markRunStarted();
  const withRecovery = bm.findToolExhaustion({
    permissionAllowed: true,
    toolPermission: "read",
    steps: [
      { iteration: 1, tool: "read_file", ok: true, permission: "read" },
      { iteration: 2, tool: "list_files", ok: false, permission: "read", systemRecovery: true },
    ],
  });
  assert.equal(withRecovery, undefined);
  const exhausted = bm.findToolExhaustion({
    permissionAllowed: true,
    toolPermission: "read",
    steps: [
      { iteration: 1, tool: "read_file", ok: true, permission: "read" },
      { iteration: 2, tool: "read_file", ok: true, permission: "read" },
    ],
  });
  assert.equal(exhausted, "maxToolCalls");
});

test("B3 RunPolicyManager 按 workflowType 路由权限", () => {
  const manager = new RunPolicyManager();
  const policy = manager.resolve({
    message: "testTs项目这个星空看起来有点假，我需要那种漫天星空的感觉",
  });
  assert.equal(policy.intent, "edit");
  assert.equal(policy.workflowType, "editWorkflow");
  assert.equal(policy.needsWrite, true);
  assert.ok(policy.legacyIntentHint === undefined || policy.intent === "edit");
});

test("A1 历史完成声明无 ledger → historical_reference", () => {
  const guard = evaluateCompletionGuard({
    goal: "安装依赖",
    intent: "run",
    mode: "implement",
    answer:
      "根据历史记录，`testTS` 项目的依赖安装已在之前成功完成。执行 `npm install` 后安装了 three 与 typescript。当前依赖已就绪，无需额外操作。",
    steps: [],
  });
  assert.equal(guard.status, "historical_reference");
});

test("D2 classifier prompt 注入 reconciled 与 completionStatus", () => {
  const text = buildIntentClassifierUserMessage({
    message: "继续",
    context: {
      taskContext: {
        sessionId: "s1",
        currentPhase: "executing",
        intent: "edit",
        workflowType: "editWorkflow",
        reconciledIntent: "edit",
        reconciledWorkflowType: "editWorkflow",
        entryIntent: "generate_file",
        lastCompletionStatus: "misleading_completion",
        isActive: true,
        updatedAt: new Date().toISOString(),
      },
      completionStatus: "misleading_completion",
    },
  });
  assert.ok(text.includes("workflow=editWorkflow"));
  assert.ok(text.includes("completionStatus=misleading_completion"));
});

test("D5 recovery_partial UI 标签", () => {
  const p = presentExecutionState({ stopReason: "recovery_partial" });
  assert.equal(p.userFacingLabel, "部分完成 · 恢复预算耗尽");
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
console.log(`\narchitecture-audit: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
