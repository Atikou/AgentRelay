/**
 * Run 报告时间线自检。
 * 运行：npm run test:run-report
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildRunReport,
  buildRunTimeline,
  enrichRunTimeline,
  mapTraceEventToTimelineEntry,
} from "../src/trace/runReport.js";
import { assertWithinCostBudget, CostBudgetExceededError } from "../src/util/costBudget.js";

const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void) {
  tests.push({ name, fn });
}

test("buildRunReport 聚合 runId 事件与用量", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "run-report-"));
  const traceFile = path.join(tmp, "trace.jsonl");
  const runId = "run-abc";
  await writeFile(
    traceFile,
    [
      JSON.stringify({ type: "run_start", runId, time: "2026-06-14T00:00:00.000Z", kind: "agent" }),
      JSON.stringify({
        type: "agent_model_turn",
        runId,
        time: "2026-06-14T00:00:01.000Z",
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.001,
      }),
      JSON.stringify({
        type: "run_usage_summary",
        runId,
        time: "2026-06-14T00:00:02.000Z",
        totalCostUsd: 0.001,
        modelTurns: 1,
      }),
      JSON.stringify({ type: "run_start", runId: "other", time: "2026-06-14T00:00:03.000Z" }),
    ].join("\n"),
    "utf-8",
  );

  const report = await buildRunReport(traceFile, runId);
  assert.ok(report);
  assert.equal(report!.runId, runId);
  assert.equal(report!.eventCount, 3);
  assert.equal(report!.usage.modelTurns, 1);
  assert.equal(report!.usage.totalCostUsd, 0.001);
  assert.equal(report!.timeline.length, 3);
  assert.equal(report!.timeline[0]!.category, "run");
  assert.equal(report!.timeline[1]!.category, "model");

  await rm(tmp, { recursive: true, force: true });
});

test("mapTraceEventToTimelineEntry 分类 tool 与 task", () => {
  const tool = mapTraceEventToTimelineEntry({
    type: "tool_audit",
    time: "t1",
    tool: "read_file",
    status: "ok",
  });
  assert.equal(tool?.category, "tool");

  const obsFail = mapTraceEventToTimelineEntry({
    type: "tool_audit",
    time: "t2",
    tool: "read_file",
    outcomeClass: "observation_failure",
    outcomeKind: "not_found",
  });
  assert.equal(obsFail?.status, "observation_failure");
  assert.equal(obsFail?.refs?.outcomeKind, "not_found");

  const task = mapTraceEventToTimelineEntry({
    type: "task_status_change",
    time: "t2",
    scope: "step",
    from: "pending",
    to: "running",
  });
  assert.equal(task?.category, "task");
});

test("enrichRunTimeline 合并 routing 与 fallback", () => {
  const base = buildRunTimeline([
    { type: "run_start", time: "2026-06-14T00:00:00.000Z", kind: "chat" },
  ]);
  const enriched = enrichRunTimeline(base, {
    runCreatedAt: "2026-06-14T00:00:00.000Z",
    runUpdatedAt: "2026-06-14T00:05:00.000Z",
    routeLogs: [
      {
        id: "route-1",
        userInputPreview: "hi",
        taskType: "chat",
        selectedLevel: 1,
        executionStrategy: "single_model",
        risk: "low",
        reason: "test",
        source: "rule",
        candidates: [],
        requireUserConfirmation: false,
        createdAt: "2026-06-14T00:01:00.000Z",
      },
    ],
    fallbackLogs: [
      {
        id: "fb-1",
        routeLogId: "route-1",
        fromModelId: "local-a",
        toModelId: "cloud-b",
        fromStrategy: "single_model",
        toStrategy: "strong_model_direct",
        triggerType: "model_error",
        reason: "upgrade",
        createdAt: "2026-06-14T00:02:00.000Z",
      },
    ],
  });
  assert.equal(enriched.length, 3);
  assert.equal(enriched[1]!.category, "routing");
  assert.equal(enriched[2]!.category, "fallback");
});

test("accumulateUsage 区分 observation_failure 与 execution_error", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "run-report-outcome-"));
  const traceFile = path.join(tmp, "trace.jsonl");
  const runId = "run-outcome";
  await writeFile(
    traceFile,
    [
      JSON.stringify({
        type: "tool_audit",
        runId,
        time: "t1",
        tool: "read_file",
        outcomeClass: "observation_failure",
        outcomeKind: "not_found",
      }),
      JSON.stringify({
        type: "tool_audit",
        runId,
        time: "t2",
        tool: "write_file",
        outcomeClass: "execution_error",
        outcomeKind: "permission_denied",
      }),
    ].join("\n"),
    "utf-8",
  );
  const report = await buildRunReport(traceFile, runId);
  assert.ok(report);
  assert.equal(report!.usage.toolCalls, 2);
  assert.equal(report!.usage.toolObservationFailures, 1);
  assert.equal(report!.usage.toolExecutionErrors, 1);
  assert.equal(report!.usage.toolFailures, 2);
  await rm(tmp, { recursive: true, force: true });
});

test("assertWithinCostBudget 超出上限抛错", () => {
  assert.throws(() => assertWithinCostBudget(1.5, 1), CostBudgetExceededError);
  assert.doesNotThrow(() => assertWithinCostBudget(0.5, 1));
});

async function main() {
  for (const t of tests) {
    await t.fn();
    console.log(`ok ${t.name}`);
  }
  console.log(`\n${tests.length} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
