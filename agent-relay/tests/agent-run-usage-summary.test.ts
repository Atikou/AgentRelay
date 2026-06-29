/**
 * AgentRunUsageSummary 自检。
 * 运行：npm run test:agent-run-usage-summary
 */
import assert from "node:assert/strict";

import {
  buildRunUsageSummaryTracePayload,
  sumOptional,
  type AgentModelTurnMetric,
} from "../src/agent/AgentRunUsageSummary.js";
import type { AgentExecutionMeta } from "../src/agent/RunPolicyTypes.js";
import type { AgentToolStep } from "../src/agent/toolStep.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

function executionMeta(stopReason = "completed"): AgentExecutionMeta {
  return {
    mode: "chat",
    modeSource: "inferred",
    executionStage: "analyze",
    userFacingLabel: "已完成",
    userFacingDetail: "",
    stopReason,
    budget: {
      maxModelTurns: 3,
      maxToolCalls: 5,
      maxReadCalls: 5,
      maxWriteCalls: 0,
      maxShellCalls: 0,
      maxRuntimeMs: 60000,
      maxPreflightTools: 3,
      maxRecoveryTurns: 1,
      maxRepeatedToolFailures: 2,
    },
    usage: {
      modelTurns: 2,
      toolCalls: 3,
      readCalls: 2,
      writeCalls: 0,
      shellCalls: 0,
      runtimeMs: 123,
    },
  } as AgentExecutionMeta;
}

function step(overrides: Partial<AgentToolStep>): AgentToolStep {
  return {
    iteration: 1,
    tool: "read_file",
    input: {},
    ok: true,
    ...overrides,
  };
}

test("sumOptional 忽略 undefined 并保留 6 位小数", () => {
  assert.equal(sumOptional([undefined, undefined]), undefined);
  assert.equal(sumOptional([0.1, undefined, 0.2, 0.0000004]), 0.3);
});

test("buildRunUsageSummaryTracePayload 汇总模型 token、耗时与费用", () => {
  const metrics: AgentModelTurnMetric[] = [
    { iteration: 1, success: true, latencyMs: 30, inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
    { iteration: 2, success: true, latencyMs: 70, inputTokens: 4, outputTokens: 1, costUsd: 0.002 },
  ];
  const payload = buildRunUsageSummaryTracePayload({
    steps: [],
    executionMeta: executionMeta(),
    modelTurnMetrics: metrics,
    runId: "run-1",
    sessionId: "session-1",
    taskId: "task-1",
    mode: "chat",
  });
  assert.equal(payload.type, "run_usage_summary");
  assert.equal(payload.runId, "run-1");
  assert.equal(payload.modelTurns, 2);
  assert.equal(payload.modelSuccesses, 2);
  assert.equal(payload.inputTokens, 14);
  assert.equal(payload.outputTokens, 6);
  assert.equal(payload.totalTokens, 20);
  assert.equal(payload.modelLatencyMs, 100);
  assert.equal(payload.costUsd, 0.003);
});

test("buildRunUsageSummaryTracePayload 汇总工具失败与 blocked", () => {
  const payload = buildRunUsageSummaryTracePayload({
    steps: [
      step({ ok: true, outcomeClass: "observation_success" }),
      step({ ok: false, outcomeClass: "observation_failure", error: "not found" }),
      step({ ok: false, outcomeClass: "execution_error", error: "crash" }),
      step({ ok: false, outcomeClass: "execution_error", blocked: true, error: "denied" }),
    ],
    executionMeta: executionMeta("budget_exhausted"),
    modelTurnMetrics: [{ iteration: 1, success: false, latencyMs: 10, error: "model failed" }],
    mode: "implement",
  });
  assert.equal(payload.reachedLimit, true);
  assert.equal(payload.modelErrors, 1);
  assert.equal(payload.toolCalls, 4);
  assert.equal(payload.toolFailures, 2);
  assert.equal(payload.toolObservationFailures, 1);
  assert.equal(payload.toolExecutionErrors, 1);
  assert.equal(payload.failedTools, 2);
  assert.equal(payload.blockedTools, 1);
  assert.deepEqual(payload.errors, ["model failed", "not found", "crash"]);
});

test("buildRunUsageSummaryTracePayload 最多保留 10 条错误", () => {
  const steps = Array.from({ length: 12 }, (_, index) =>
    step({ ok: false, outcomeClass: "execution_error", error: `tool-${index}` }),
  );
  const payload = buildRunUsageSummaryTracePayload({
    steps,
    executionMeta: executionMeta(),
    modelTurnMetrics: [],
    mode: "chat",
  });
  assert.equal((payload.errors as string[]).length, 10);
});

function main() {
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
  console.log(`\nagent-run-usage-summary: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
