/**
 * RunPolicyVocabulary 单元测试。
 * 运行：npm run test:run-policy-vocabulary
 */
import assert from "node:assert/strict";

import {
  INTERNAL_EXECUTION_META_FIELDS,
  isInternalExecutionMetaField,
  toPublicExecutionMeta,
} from "../src/agent/RunPolicyVocabulary.js";
import { MODE_BASE_BUDGETS } from "../src/agent/runBudgetDefaults.js";
import type { AgentExecutionMeta } from "../src/agent/RunPolicyTypes.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

function sampleMeta(): AgentExecutionMeta {
  return {
    mode: "implement",
    modeSource: "explicit",
    intent: "edit",
    workflowType: "editWorkflow",
    entryIntent: "answer",
    entryWorkflowType: "answerWorkflow",
    reconciledIntent: "edit",
    reconciledWorkflowType: "editWorkflow",
    permissionPolicy: "confirmBeforeEdit",
    userFacingLabel: "正在修改文件",
    stopReason: "completed",
    budget: MODE_BASE_BUDGETS.implement,
    usage: {
      modelTurns: 1,
      mainModelTurns: 1,
      toolCalls: 0,
      readCalls: 0,
      writeCalls: 0,
      shellCalls: 0,
      runtimeMs: 10,
      preflightTools: 0,
      recoveryTurns: 0,
      cachedToolHits: 0,
    },
    usedIterations: 1,
    usedModelTurns: 1,
    usedToolCalls: 0,
    usedReadCalls: 0,
    usedWriteCalls: 0,
    usedShellCalls: 0,
    needsMoreBudget: false,
  };
}

test("toPublicExecutionMeta 剥离内部 mode 词汇", () => {
  const pub = toPublicExecutionMeta(sampleMeta());
  assert.equal(pub.intent, "edit");
  assert.equal(pub.workflowType, "editWorkflow");
  assert.equal(pub.userFacingLabel, "正在修改文件");
  assert.equal((pub as { mode?: string }).mode, undefined);
  assert.equal((pub as { entryIntent?: string }).entryIntent, undefined);
  assert.equal((pub as { reconciledIntent?: string }).reconciledIntent, undefined);
});

test("isInternalExecutionMetaField 识别内部字段", () => {
  assert.equal(isInternalExecutionMetaField("mode"), true);
  assert.equal(isInternalExecutionMetaField("intent"), false);
  assert.equal(INTERNAL_EXECUTION_META_FIELDS.includes("mode"), true);
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    passed++;
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${t.name}`);
    console.error(err);
  }
}
console.log(`\nrun-policy-vocabulary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
