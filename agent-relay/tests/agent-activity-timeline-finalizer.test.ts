/**
 * AgentActivityTimelineFinalizer 单元测试。
 * 运行：npm run test:agent-activity-timeline-finalizer
 */
import assert from "node:assert/strict";

import {
  finalizeAgentActivityTimeline,
  type AgentActivityTimelineSink,
} from "../src/agent/AgentActivityTimelineFinalizer.js";

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

function makeTimeline() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const tl: AgentActivityTimelineSink = {
    getRun: () => ({ id: "run-from-timeline" }),
    startStep: (input) => {
      calls.push({ name: "startStep", args: [input] });
      return { id: "summary-step" };
    },
    completeStep: (...args) => {
      calls.push({ name: "completeStep", args });
    },
    completeRun: (...args) => {
      calls.push({ name: "completeRun", args });
    },
    partialCompleteRun: (...args) => {
      calls.push({ name: "partialCompleteRun", args });
    },
    failRun: (...args) => {
      calls.push({ name: "failRun", args });
    },
    cancelRun: (...args) => {
      calls.push({ name: "cancelRun", args });
    },
  };
  return { tl, calls };
}

test("completed run writes a summary step and completes the timeline", () => {
  const { tl, calls } = makeTimeline();
  finalizeAgentActivityTimeline({
    timeline: tl,
    runId: "run-explicit",
    answer: "任务已经完成",
    reachedLimit: false,
    stopReason: "completed",
    maxRecoveryTurns: 3,
  });

  assert.deepEqual(calls.map((c) => c.name), ["startStep", "completeStep", "completeRun"]);
  assert.deepEqual(calls[0]!.args[0], {
    runId: "run-explicit",
    type: "summary",
    title: "任务完成",
    content: "任务已经完成",
  });
  assert.equal(calls[2]!.args[0], "任务已经完成");
});

test("awaiting_permission records a partial timeline state", () => {
  const { tl, calls } = makeTimeline();
  finalizeAgentActivityTimeline({
    timeline: tl,
    answer: "",
    reachedLimit: false,
    stopReason: "awaiting_permission",
    partialSummary: "需要授权 shell",
    maxRecoveryTurns: 3,
  });

  assert.deepEqual(calls, [
    { name: "partialCompleteRun", args: ["需要授权 shell", "等待工具授权"] },
  ]);
});

test("completion guard partial status overrides completed stop reason", () => {
  const { tl, calls } = makeTimeline();
  finalizeAgentActivityTimeline({
    timeline: tl,
    answer: "模型声称完成",
    reachedLimit: false,
    stopReason: "completed",
    completionGuard: {
      status: "misleading_completion",
      reason: "缺少实际写入工具证据",
    },
    maxRecoveryTurns: 3,
  });

  assert.deepEqual(calls, [
    {
      name: "partialCompleteRun",
      args: ["缺少实际写入工具证据", "任务未完全完成"],
    },
  ]);
});

test("budget exhausted uses ledger recovery count in default summary", () => {
  const { tl, calls } = makeTimeline();
  finalizeAgentActivityTimeline({
    timeline: tl,
    answer: "",
    reachedLimit: true,
    budgetExhausted: "maxToolCalls",
    budgetLedger: {
      preflightTools: 1,
      recoveryTurns: 2,
      cachedToolHits: 0,
    },
    maxRecoveryTurns: 5,
  });

  assert.deepEqual(calls, [
    {
      name: "partialCompleteRun",
      args: ["运行预算耗尽：maxToolCalls（恢复 2/5）", "部分完成 · 预算耗尽"],
    },
  ]);
});

test("user cancellation cancels timeline without writing summary", () => {
  const { tl, calls } = makeTimeline();
  finalizeAgentActivityTimeline({
    timeline: tl,
    answer: "",
    reachedLimit: false,
    stopReason: "user_cancelled",
    maxRecoveryTurns: 3,
  });

  assert.deepEqual(calls, [{ name: "cancelRun", args: ["用户取消"] }]);
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok ${t.name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${t.name}`, error);
  }
}
if (failed > 0) process.exitCode = 1;
