/**
 * Trace 分段写入、轮转与索引自检。
 * 运行：npm run test:trace-rotation
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { migrateLegacyTraceFile } from "../src/trace/traceCatalog.js";
import { TraceIndexStore } from "../src/trace/TraceIndexStore.js";
import { createSegmentedTraceLogger } from "../src/trace/TraceLogger.js";
import { resolveTracePaths } from "../src/trace/tracePaths.js";
import { scanTraceEvents } from "../src/trace/traceQuery.js";
import { readRecentTraceEvents } from "../src/trace/traceReader.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

let tmpRoot = "";

test("分段写入落到 active/trace-current.jsonl 并写索引", async () => {
  const tracesDir = path.join(tmpRoot, "write");
  const { logger, index } = createSegmentedTraceLogger(tracesDir, {
    rotationMaxBytes: 1024 * 1024,
    rotationMaxAgeHours: 24,
  });
  logger.write({ type: "run_start", runId: "run-1", sessionId: "sess-1" });
  logger.write({ type: "tool_audit", runId: "run-1", status: "ok" });
  await logger.close();
  index.close();

  const layout = resolveTracePaths(tracesDir);
  assert.ok(existsSync(layout.activeFile));
  const reopened = new TraceIndexStore(layout.indexDbPath);
  assert.ok(reopened.findSegmentPathsByRunId("run-1").length >= 1);
  reopened.close();
});

test("显式 rotate 将 active 移入 segments", async () => {
  const tracesDir = path.join(tmpRoot, "rotate");
  const { logger, index } = createSegmentedTraceLogger(tracesDir, {
    rotationMaxBytes: 1024 * 1024,
    rotationMaxAgeHours: 24,
  });
  logger.write({ type: "run_start", runId: "run-rot", sessionId: "s1" });
  const before = readFileSync(resolveTracePaths(tracesDir).activeFile, "utf-8");
  assert.ok(before.includes("run-rot"));

  const rotated = logger.rotate({ force: true });
  assert.equal(rotated.rotated, true);
  assert.ok(rotated.segmentPath);

  const layout = resolveTracePaths(tracesDir);
  const segAbs = path.join(tracesDir, rotated.segmentPath!);
  assert.ok(existsSync(segAbs));
  assert.ok(readFileSync(segAbs, "utf-8").includes("run-rot"));

  logger.write({ type: "run_end", runId: "run-rot" });
  await logger.close();
  index.close();
});

test("legacy trace.jsonl 迁移后可按 runId 查询", async () => {
  const tracesDir = path.join(tmpRoot, "legacy");
  const layout = resolveTracePaths(tracesDir);
  await mkdir(path.dirname(layout.legacyFile), { recursive: true });
  await writeFile(
    layout.legacyFile,
    [
      JSON.stringify({ type: "run_start", runId: "legacy-run", time: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({ type: "tool_audit", runId: "legacy-run", time: "2026-01-01T00:00:01.000Z" }),
    ].join("\n"),
    "utf-8",
  );

  const index = new TraceIndexStore(layout.indexDbPath);
  assert.ok(migrateLegacyTraceFile({ tracesDir, index }));
  assert.ok(!existsSync(layout.legacyFile));

  const events = await scanTraceEvents(layout.activeFile, {
    limit: 20,
    redact: false,
    filter: { runId: "legacy-run", replayOnly: false },
    catalog: { tracesDir, index },
  });
  assert.equal(events.length, 2);
  index.close();
});

test("readRecentTraceEvents 合并 active 与 segments 尾部", async () => {
  const tracesDir = path.join(tmpRoot, "tail");
  const layout = resolveTracePaths(tracesDir);
  await mkdir(path.dirname(layout.activeFile), { recursive: true });
  await mkdir(path.join(tracesDir, "segments", "2026", "06"), { recursive: true });
  writeFileSync(
    path.join(tracesDir, "segments", "2026", "06", "trace-20260601-0001.jsonl"),
    `${JSON.stringify({ type: "run_start", runId: "old", time: "2026-06-01T00:00:00.000Z" })}\n`,
    "utf-8",
  );
  writeFileSync(
    layout.activeFile,
    `${JSON.stringify({ type: "run_end", runId: "new", time: "2026-06-13T00:00:00.000Z" })}\n`,
    "utf-8",
  );

  const events = readRecentTraceEvents(layout.activeFile, {
    limit: 10,
    redact: false,
    catalog: { tracesDir },
  });
  assert.equal(events.length, 2);
  const runIds = events.map((e) => (e as { runId?: string }).runId);
  assert.ok(runIds.includes("old"));
  assert.ok(runIds.includes("new"));
});

async function main(): Promise<void> {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "ar-trace-rot-"));
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok - ${t.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL - ${t.name}`);
      console.error(error);
    }
  }
  try {
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // ignore windows lock
  }
  if (failed > 0) process.exitCode = 1;
  else console.log(`\n${tests.length} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
