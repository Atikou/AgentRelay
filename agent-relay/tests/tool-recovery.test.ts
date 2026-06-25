/**
 * ToolRecoveryWorkflow 自检。
 * 运行：npm run test:tool-recovery
 */
import assert from "node:assert/strict";

import { ToolRecoveryWorkflow } from "../src/agent/ToolRecoveryWorkflow.js";
import { applyOutcomeToStep } from "../src/agent/recovery/renderToolOutcome.js";
import {
  buildCommandFailedOutcome,
  buildNoResultsOutcome,
  buildNotFoundOutcome,
} from "../src/tools/toolOutcome.js";
import type { AgentToolStep } from "../src/agent/toolStep.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

function stepWithOutcome(tool: string, input: Record<string, unknown>, outcome: ReturnType<typeof buildNotFoundOutcome>): AgentToolStep {
  return applyOutcomeToStep({ iteration: 1, tool, input, ok: false }, outcome, { executed: true });
}

test("run 意图 not_found 注入恢复路线", () => {
  const step = stepWithOutcome("read_file", { path: "testTS/index.html" }, buildNotFoundOutcome("testTS/index.html"));
  const result = new ToolRecoveryWorkflow().run({ intent: "run", goal: "启动 Vite", step });
  assert.ok(result?.modelContext);
  assert.match(result!.modelContext, /list_files/);
});

test("debug 意图 command_failed 注入恢复路线", () => {
  const outcome = buildCommandFailedOutcome("npm test", 1, "Assertion failed");
  const step = stepWithOutcome("shell_run", { command: "npm test" }, outcome);
  const result = new ToolRecoveryWorkflow().run({ intent: "debug", goal: "修测试", step });
  assert.ok(result?.modelContext);
  assert.match(result!.modelContext, /command_failed/);
});

test("no_results 注入放宽搜索路线", () => {
  const step = stepWithOutcome("search_text", { query: "foo" }, buildNoResultsOutcome("foo", "."));
  const result = new ToolRecoveryWorkflow().run({ intent: "debug", goal: "找代码", step });
  assert.ok(result?.modelContext);
  assert.match(result!.modelContext, /no_results/);
});

test("answer 意图不注入恢复路线", () => {
  const step = stepWithOutcome("read_file", { path: "a.ts" }, buildNotFoundOutcome("a.ts"));
  assert.equal(new ToolRecoveryWorkflow().run({ intent: "answer", goal: "问答", step }), undefined);
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
console.log(`\ntool-recovery: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
