/**
 * Run 报告导出自检。
 * 运行：npm run test:run-report
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildRunReport } from "../src/trace/runReport.js";
import { assertWithinCostBudget, CostBudgetExceededError } from "../src/util/costBudget.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("buildRunReport 聚合 runId 事件与用量", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "run-report-"));
  const traceFile = path.join(tmp, "trace.jsonl");
  const runId = "run-abc";
  await writeFile(
    traceFile,
    [
      JSON.stringify({ type: "run_start", runId, ts: "1" }),
      JSON.stringify({
        type: "agent_model_turn",
        runId,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.001,
      }),
      JSON.stringify({ type: "run_usage_summary", runId, totalCostUsd: 0.001, modelTurns: 1 }),
      JSON.stringify({ type: "run_start", runId: "other", ts: "2" }),
    ].join("\n"),
    "utf-8",
  );

  const report = await buildRunReport(traceFile, runId);
  assert.ok(report);
  assert.equal(report!.runId, runId);
  assert.equal(report!.eventCount, 3);
  assert.equal(report!.usage.modelTurns, 1);
  assert.equal(report!.usage.totalCostUsd, 0.001);

  await rm(tmp, { recursive: true, force: true });
});

test("assertWithinCostBudget 超出上限抛错", () => {
  assert.throws(() => assertWithinCostBudget(1.5, 1), CostBudgetExceededError);
  assert.doesNotThrow(() => assertWithinCostBudget(0.5, 1));
});

let passed = 0;
for (const t of tests) {
  await t.fn();
  passed++;
  console.log(`  ✓ ${t.name}`);
}
console.log(`\nrun-report: ${passed}/${tests.length} passed`);
