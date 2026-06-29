/**
 * 数据生命周期与清理治理自检。
 * 运行：npm run test:data-lifecycle
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { rm, mkdtemp as mkdtempAsync } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ContextManager } from "../src/context/ContextManager.js";
import { InMemoryVectorStore } from "../src/context/VectorStore.js";
import { RunStore } from "../src/orchestrator/RunStore.js";
import { DataLifecycleService } from "../src/lifecycle/DataLifecycleService.js";
import { loadLifecyclePolicy } from "../src/lifecycle/policy.js";
import { deleteRunArtifacts, findRunIdsForSession } from "../src/lifecycle/SessionArtifactCleaner.js";
import { CleanupPlanner } from "../src/lifecycle/CleanupPlanner.js";
import { purgeSessionPrivacy } from "../src/lifecycle/SessionPrivacyPurger.js";
import { ActivityRunStore, buildActivityRunManifest } from "../src/agent/timeline/ActivityRunStore.js";
import { TraceIndexStore } from "../src/trace/TraceIndexStore.js";
import { resolveTracePaths } from "../src/trace/tracePaths.js";
import { ToolStorage } from "../src/tools/storage/ToolStorage.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

function makeService(opts: {
  dataDir: string;
  workspaceRoot: string;
  memoryDb?: ContextManager;
  activeRunIds?: string[];
}): DataLifecycleService {
  const mgr =
    opts.memoryDb ??
    new ContextManager({
      dataDir: opts.dataDir,
      useLanceDb: false,
      vectorStore: new InMemoryVectorStore(),
    });
  const tracesDir = path.join(opts.dataDir, "traces");
  const layout = resolveTracePaths(tracesDir);
  mkdirSync(path.dirname(layout.activeFile), { recursive: true });
  mkdirSync(layout.segmentsDir, { recursive: true });
  const index = new TraceIndexStore(layout.indexDbPath);
  return new DataLifecycleService({
    dataDir: opts.dataDir,
    workspaceRoot: opts.workspaceRoot,
    traceFile: layout.activeFile,
    tracesDir,
    traceCatalog: { tracesDir, index },
    notificationFile: path.join(opts.dataDir, "notifications", "notifications.jsonl"),
    schedulerJournalFile: path.join(opts.dataDir, "scheduler", "triggers.jsonl"),
    memoryDb: mgr.db,
    toolsDbPath: path.join(opts.dataDir, "agent_data", "tools.db"),
    getActiveRunIds: () => opts.activeRunIds ?? [],
  });
}

function touchOldFile(filePath: string, ageDays: number): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "stale-data\n", "utf-8");
  const mtime = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  utimesSync(filePath, mtime, mtime);
}

let tmpRoot = "";

test("policy 首次加载写入默认 policy.json", async () => {
  const dataDir = path.join(tmpRoot, "policy");
  const policy = loadLifecyclePolicy(dataDir);
  assert.equal(policy.version, 1);
  assert.equal(policy.retentionDays.temp, 1);
  assert.equal(policy.cleanup.autoEnabled, true);
  assert.equal(policy.trace.compressOldSegments, true);
  assert.ok(existsSync(path.join(dataDir, "lifecycle", "policy.json")));
});

test("StorageUsage 统计 temp 与 trace", async () => {
  const dataDir = path.join(tmpRoot, "usage");
  const workspace = path.join(tmpRoot, "ws-usage");
  touchOldFile(path.join(dataDir, "temp", "old.tmp"), 2);
  mkdirSync(path.join(dataDir, "traces"), { recursive: true });
  writeFileSync(path.join(dataDir, "traces", "trace.jsonl"), "x".repeat(100), "utf-8");

  const svc = makeService({ dataDir, workspaceRoot: workspace });
  const usage = svc.getUsage();
  assert.ok(usage.totalBytes >= 100);
  const tempCat = usage.categories.find((c) => c.name === "temp");
  assert.ok(tempCat && tempCat.bytes > 0);
  const traceCat = usage.categories.find((c) => c.name === "trace");
  assert.ok(traceCat && traceCat.bytes >= 100);
});

test("preview 识别过期 temp 且 dry-run 不删文件", async () => {
  const dataDir = path.join(tmpRoot, "preview");
  const workspace = path.join(tmpRoot, "ws-preview");
  const stale = path.join(dataDir, "temp", "stale.tmp");
  touchOldFile(stale, 3);

  const svc = makeService({ dataDir, workspaceRoot: workspace });
  const report = svc.preview({ scope: "safe" });
  assert.equal(report.mode, "dry-run");
  assert.ok(report.summary.estimatedBytesToFree > 0);
  assert.ok(report.actions.some((a) => a.path === stale && a.risk === "low"));
  assert.ok(existsSync(stale));
});

test("active run 关联 timeline 不进入可删候选", async () => {
  const dataDir = path.join(tmpRoot, "active");
  const workspace = path.join(tmpRoot, "ws-active");
  const runId = "run-active-001";
  const timelineDir = path.join(workspace, ".agent", "runs", runId);
  mkdirSync(timelineDir, { recursive: true });
  writeFileSync(path.join(timelineDir, "events.jsonl"), "{}\n", "utf-8");

  const svc = makeService({ dataDir, workspaceRoot: workspace, activeRunIds: [runId] });
  const report = svc.preview({ scope: "all", include: ["timeline"], maxRisk: "high" });
  const blocked = report.actions.find((a) => a.path.includes(runId));
  if (blocked) {
    assert.equal(blocked.canDelete, false);
    assert.ok(blocked.blockedReason?.includes("active"));
  }
});

test("apply safe cleanup 删除 temp 并写 journal", async () => {
  const dataDir = path.join(tmpRoot, "apply");
  const workspace = path.join(tmpRoot, "ws-apply");
  const stale = path.join(dataDir, "temp", "gone.tmp");
  touchOldFile(stale, 5);

  const svc = makeService({ dataDir, workspaceRoot: workspace });
  const preview = svc.preview({ scope: "safe" });
  const result = svc.apply({ cleanupRunId: preview.cleanupRunId, confirm: true });
  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.ok(result.applied >= 1);
  assert.ok(!existsSync(stale));
  const journal = path.join(dataDir, "lifecycle", "cleanup-runs.jsonl");
  assert.ok(existsSync(journal));
  const text = readFileSync(journal, "utf-8");
  assert.ok(text.includes("success"));
});

test("删除会话联动清理 timeline 并写 tombstone", async () => {
  const dataDir = path.join(tmpRoot, "session-del");
  const workspace = path.join(tmpRoot, "ws-session");
  const mgr = new ContextManager({
    dataDir,
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const runs = new RunStore(mgr.db);
  const session = mgr.createSession("待删会话");
  const run = runs.create({ kind: "agent", sessionId: session.id, status: "completed" });
  const timelineDir = path.join(workspace, ".agent", "runs", run.id);
  mkdirSync(timelineDir, { recursive: true });
  writeFileSync(path.join(timelineDir, "summary.md"), "# done\n", "utf-8");

  const runIds = findRunIdsForSession(mgr.db, session.id);
  assert.deepEqual(runIds, [run.id]);

  const svc = makeService({ dataDir, workspaceRoot: workspace, memoryDb: mgr });
  mgr.deleteSession(session.id);
  const artifacts = svc.onSessionDeleted(session.id, runIds);
  assert.equal(artifacts.runIds.length, 1);
  assert.ok(!existsSync(timelineDir));

  const tombstone = path.join(dataDir, "lifecycle", "tombstones.jsonl");
  assert.ok(existsSync(tombstone));
  assert.ok(readFileSync(tombstone, "utf-8").includes(session.id));
  mgr.close();
});

test("DELETE run 联动清理 timeline 与 data/runs", async () => {
  const dataDir = path.join(tmpRoot, "run-del");
  const workspace = path.join(tmpRoot, "ws-run-del");
  const mgr = new ContextManager({
    dataDir,
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const runs = new RunStore(mgr.db);
  const run = runs.create({ kind: "agent", status: "completed" });
  const timelineDir = path.join(workspace, ".agent", "runs", run.id);
  mkdirSync(timelineDir, { recursive: true });
  writeFileSync(path.join(timelineDir, "summary.md"), "# ok\n", "utf-8");

  runs.delete(run.id);
  const result = deleteRunArtifacts({
    dataDir,
    workspaceRoot: workspace,
    runId: run.id,
  });
  assert.ok(!existsSync(timelineDir));
  assert.ok(result.bytesFreed >= 0);

  const tombstone = path.join(dataDir, "lifecycle", "tombstones.jsonl");
  assert.ok(readFileSync(tombstone, "utf-8").includes(run.id));
  mgr.close();
});

test("CleanupPlanner 可压紧过期 scheduler journal", async () => {
  const dataDir = path.join(tmpRoot, "sched-journal");
  const journalFile = path.join(dataDir, "scheduler", "scheduler-journal.jsonl");
  mkdirSync(path.dirname(journalFile), { recursive: true });
  const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
  const recent = new Date().toISOString();
  writeFileSync(
    journalFile,
    [
      JSON.stringify({ op: "upsert", time: old, trigger: { id: "t1", updatedAt: old } }),
      JSON.stringify({ op: "upsert", time: recent, trigger: { id: "t1", updatedAt: recent } }),
    ].join("\n") + "\n",
    "utf-8",
  );

  const policy = loadLifecyclePolicy(dataDir);
  const tracesDir = path.join(dataDir, "traces");
  mkdirSync(tracesDir, { recursive: true });
  const mgr = new ContextManager({
    dataDir,
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const planner = new CleanupPlanner(
    {
      dataDir,
      workspaceRoot: path.join(tmpRoot, "ws-sched"),
      traceFile: path.join(tracesDir, "trace.jsonl"),
      tracesDir,
      notificationFile: path.join(dataDir, "notifications", "notifications.jsonl"),
      schedulerJournalFile: journalFile,
      memoryDb: mgr.db,
      getActiveRunIds: () => [],
    },
    policy,
  );
  const actions = planner.plan({ scope: "safe" });
  assert.ok(actions.some((a) => a.category === "scheduler" && a.type === "compact_jsonl"));
  mgr.close();
});

test("CleanupPlanner 过期 timeline events 进入 medium 预览", async () => {
  const dataDir = path.join(tmpRoot, "tl-prune");
  const workspace = path.join(tmpRoot, "ws-tl-prune");
  const store = new ActivityRunStore(workspace);
  const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
  const run = {
    id: "run-old",
    title: "old",
    goal: "g",
    status: "success" as const,
    steps: [],
    createdAt: old,
    updatedAt: old,
    endedAt: old,
  };
  store.saveRun(run);
  store.saveSummary("run-old", "# summary\n");
  store.saveManifest(buildActivityRunManifest(run, { workspaceRoot: workspace }));
  writeFileSync(path.join(workspace, ".agent", "runs", "run-old", "events.jsonl"), "{}\n", "utf-8");

  const policy = loadLifecyclePolicy(dataDir);
  const tracesDir = path.join(dataDir, "traces");
  mkdirSync(tracesDir, { recursive: true });
  const mgr = new ContextManager({
    dataDir,
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const planner = new CleanupPlanner(
    {
      dataDir,
      workspaceRoot: workspace,
      traceFile: path.join(tracesDir, "trace.jsonl"),
      tracesDir,
      notificationFile: path.join(dataDir, "notifications", "notifications.jsonl"),
      schedulerJournalFile: path.join(dataDir, "scheduler", "scheduler-journal.jsonl"),
      memoryDb: mgr.db,
      getActiveRunIds: () => [],
    },
    policy,
  );
  const actions = planner.plan({ scope: "all", maxRisk: "medium" });
  assert.ok(actions.some((a) => a.path.includes("events.jsonl") && a.risk === "medium"));
  mgr.close();
});

test("隐私清除重写 trace 并清理 tools/routing", async () => {
  const dataDir = path.join(tmpRoot, "purge");
  const workspace = path.join(tmpRoot, "ws-purge");
  const mgr = new ContextManager({
    dataDir,
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const runs = new RunStore(mgr.db);
  const session = mgr.createSession("隐私测试");
  const run = runs.create({ kind: "agent", sessionId: session.id, status: "completed" });

  const tracesDir = path.join(dataDir, "traces");
  const layout = resolveTracePaths(tracesDir);
  mkdirSync(path.join(tracesDir, "segments", "2026", "06"), { recursive: true });
  const segRel = "segments/2026/06/trace-purge-test.jsonl";
  const segAbs = path.join(tracesDir, segRel);
  writeFileSync(
    segAbs,
    [
      JSON.stringify({ type: "run_start", sessionId: session.id, runId: run.id, time: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({ type: "run_end", sessionId: "other-session", runId: "other-run", time: "2026-01-01T00:00:01.000Z" }),
    ].join("\n") + "\n",
    "utf-8",
  );
  const index = new TraceIndexStore(layout.indexDbPath);
  index.insert({
    eventId: "e1",
    ts: Date.now(),
    sessionId: session.id,
    runId: run.id,
    eventType: "run_start",
    segmentPath: segRel,
  });

  const storage = new ToolStorage(dataDir);
  storage.insertToolLog({
    sessionId: session.id,
    toolName: "read_file",
    inputJson: "{}",
    outputJson: "{}",
    ok: true,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 1,
  });
  storage.close();

  mgr.db.connection
    .prepare(
      `INSERT INTO model_route_logs (id, session_id, user_input_preview, task_type, selected_level, execution_strategy, risk, reason, source, candidates_json, require_user_confirmation, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "route-purge-1",
      session.id,
      "preview",
      "chat",
      1,
      "single_model",
      "low",
      "test",
      "rule",
      "[]",
      0,
      new Date().toISOString(),
    );

  const runIds = [run.id];
  mgr.deleteSession(session.id);

  const policy = loadLifecyclePolicy(dataDir);
  const result = purgeSessionPrivacy(
    {
      dataDir,
      workspaceRoot: workspace,
      memoryDb: mgr.db,
      toolsDbPath: path.join(dataDir, "agent_data", "tools.db"),
      traceCatalog: { tracesDir, index },
      notificationFile: path.join(dataDir, "notifications", "notifications.jsonl"),
      policy,
    },
    session.id,
    runIds,
  );

  assert.equal(result.mode, "purge");
  assert.ok(result.trace.eventsRemoved >= 1);
  const segText = readFileSync(segAbs, "utf-8");
  assert.ok(!segText.includes(session.id));
  assert.ok(segText.includes("other-session"));

  const toolsDb = new DatabaseSync(path.join(dataDir, "agent_data", "tools.db"));
  const tc = toolsDb.prepare(`SELECT COUNT(*) AS c FROM tool_logs WHERE session_id=?`).get(session.id) as { c: number };
  assert.equal(Number(tc.c), 0);
  toolsDb.close();

  const routeCount = mgr.db.connection
    .prepare(`SELECT COUNT(*) AS c FROM model_route_logs WHERE session_id=?`)
    .get(session.id) as { c: number };
  assert.equal(Number(routeCount.c), 0);

  const tombstone = path.join(dataDir, "lifecycle", "tombstones.jsonl");
  assert.ok(readFileSync(tombstone, "utf-8").includes("session_purge"));

  index.close();
  mgr.close();
});

async function main(): Promise<void> {
  tmpRoot = await mkdtempAsync(path.join(os.tmpdir(), "ar-lifecycle-"));
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
    // Windows 上 SQLite 文件偶发仍被占用，忽略临时目录清理失败
  }
  if (failed > 0) process.exitCode = 1;
  else console.log(`\n${tests.length} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
