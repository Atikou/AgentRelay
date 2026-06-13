/**
 * Trace 回放过滤与导出自检。
 * 运行：npm run test:trace-replay
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  matchesTraceFilter,
  scanTraceEvents,
  summarizeTraceEvents,
} from "../src/trace/traceQuery.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("scanTraceEvents 按 runId 过滤", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "trace-replay-"));
  const traceFile = path.join(tmp, "trace.jsonl");
  await writeFile(
    traceFile,
    [
      JSON.stringify({ type: "run_start", runId: "run-a", time: "t1" }),
      JSON.stringify({ type: "tool_audit", runId: "run-a", tool: "read_file", status: "ok", time: "t2" }),
      JSON.stringify({ type: "tool_audit", runId: "run-b", tool: "read_file", status: "ok", time: "t3" }),
      JSON.stringify({ type: "model_call", runId: "run-a", time: "t4" }),
    ].join("\n"),
    "utf-8",
  );

  const events = await scanTraceEvents(traceFile, {
    limit: 20,
    redact: false,
    filter: { runId: "run-a", replayOnly: true },
  });
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => (e as { runId?: string }).runId === "run-a"));
  assert.ok(events.every((e) => e.type !== "model_call"));

  await rm(tmp, { recursive: true, force: true });
});

test("matchesTraceFilter 支持 toolCallId 与 category", () => {
  assert.equal(
    matchesTraceFilter(
      { type: "tool_audit", toolCallId: "tc-1" },
      { toolCallId: "tc-1", replayOnly: true },
    ),
    true,
  );
  assert.equal(
    matchesTraceFilter(
      { type: "agent_decision", action: "tool" },
      { category: "tool", replayOnly: true },
    ),
    false,
  );
  assert.equal(
    matchesTraceFilter(
      { type: "tool_audit", status: "ok" },
      { category: "tool", replayOnly: true },
    ),
    true,
  );
});

test("summarizeTraceEvents 汇总类型与关联 id", () => {
  const summary = summarizeTraceEvents([
    { type: "tool_audit", toolCallId: "tc-1", runId: "run-1" },
    { type: "agent_tool", toolCallId: "tc-1", runId: "run-1" },
    { type: "task_step", runId: "run-1", sessionId: "sess-1" },
  ]);
  assert.equal(summary.types.tool_audit, 1);
  assert.deepEqual(summary.toolCallIds, ["tc-1"]);
  assert.deepEqual(summary.runIds, ["run-1"]);
  assert.deepEqual(summary.sessionIds, ["sess-1"]);
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
