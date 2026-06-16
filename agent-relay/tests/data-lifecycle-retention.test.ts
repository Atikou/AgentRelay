/**
 * lifecycle delete_db_rows 与 trace 行级字段裁剪。
 * 运行：npx tsx tests/data-lifecycle-retention.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DatabaseManager } from "../src/context/DatabaseManager.js";
import { CleanupExecutor } from "../src/lifecycle/CleanupExecutor.js";
import { CleanupJournal } from "../src/lifecycle/CleanupJournal.js";
import { CleanupPlanner } from "../src/lifecycle/CleanupPlanner.js";
import {
  countSoftDeletedMemories,
  purgeSoftDeletedMemories,
} from "../src/lifecycle/dbRowCleanup.js";
import { DEFAULT_LIFECYCLE_POLICY } from "../src/lifecycle/policy.js";
import { pruneTraceSegmentFields } from "../src/lifecycle/traceFieldRetention.js";
import { ensureRoutingTables } from "../src/model-router/route-stores.js";

async function testSoftDeletedMemories(): Promise<void> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ar-life-db-"));
  try {
    const memoryDb = new DatabaseManager(tmp);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    memoryDb.connection
      .prepare(
        `INSERT INTO memories (id, scope, scope_id, memory_type, key, value, summary, importance, confidence, source, is_active, created_at, updated_at)
         VALUES (?, 'session', 's1', 'fact', 'k1', 'v1', 's', 1, 1, 'test', 0, ?, ?)`,
      )
      .run("mem-old", old, old);

    const policy = {
      ...DEFAULT_LIFECYCLE_POLICY,
      retentionDays: { ...DEFAULT_LIFECYCLE_POLICY.retentionDays, softDeletedRows: 30 },
    };
    assert.equal(countSoftDeletedMemories(memoryDb, policy), 1);
    assert.equal(purgeSoftDeletedMemories(memoryDb, policy), 1);
    assert.equal(countSoftDeletedMemories(memoryDb, policy), 0);
    memoryDb.close();
  } finally {
    try {
      await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // ignore windows sqlite lock
    }
  }
}

async function testTraceFieldPrune(): Promise<void> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ar-life-trace-"));
  try {
    const seg = path.join(tmp, "seg.jsonl");
    const oldTime = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(
      seg,
      `${JSON.stringify({
        time: oldTime,
        type: "agent_decision",
        inputPreview: "secret args",
        thought: "long thought",
      })}\n`,
      "utf-8",
    );
    const policy = {
      ...DEFAULT_LIFECYCLE_POLICY,
      retentionDays: {
        ...DEFAULT_LIFECYCLE_POLICY.retentionDays,
        toolArgs: 14,
        traceRawSuccess: 14,
      },
    };
    const result = pruneTraceSegmentFields(seg, policy);
    assert.equal(result.rewritten, true);
    assert.ok(result.bytesSaved > 0);
    const text = await import("node:fs/promises").then((fs) => fs.readFile(seg, "utf-8"));
    const parsed = JSON.parse(text.trim()) as Record<string, unknown>;
    assert.equal(parsed.inputPreview, undefined);
    assert.equal(parsed.thought, undefined);
    assert.equal(parsed.type, "agent_decision");
  } finally {
    try {
      await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // ignore
    }
  }
}

async function testPlannerAndExecutorDbRows(): Promise<void> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ar-life-plan-"));
  try {
    const dataDir = path.join(tmp, "data");
    const memoryDb = new DatabaseManager(dataDir);
    ensureRoutingTables(memoryDb.connection);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    memoryDb.connection
      .prepare(
        `INSERT INTO memories (id, scope, scope_id, memory_type, key, value, summary, importance, confidence, source, is_active, created_at, updated_at)
         VALUES (?, 'session', 's1', 'fact', 'k1', 'v1', 's', 1, 1, 'test', 0, ?, ?)`,
      )
      .run("mem-plan", old, old);

    assert.equal(countSoftDeletedMemories(memoryDb, DEFAULT_LIFECYCLE_POLICY), 1);

    const planner = new CleanupPlanner(
      {
        dataDir,
        workspaceRoot: path.join(tmp, "ws"),
        traceFile: path.join(dataDir, "traces", "active", "trace-current.jsonl"),
        tracesDir: path.join(dataDir, "traces"),
        notificationFile: path.join(dataDir, "notifications.jsonl"),
        schedulerJournalFile: path.join(dataDir, "scheduler", "journal.jsonl"),
        memoryDb,
        getActiveRunIds: () => [],
      },
      DEFAULT_LIFECYCLE_POLICY,
    );
    const actions = planner.plan({ scope: "safe" });
    assert.ok(actions.some((a) => a.type === "delete_db_rows" && a.path.includes("soft_deleted")));

    const journal = new CleanupJournal(dataDir);
    const executor = new CleanupExecutor(journal, DEFAULT_LIFECYCLE_POLICY, memoryDb);
    const dbAction = actions.find((a) => a.type === "delete_db_rows")!;
    const result = executor.apply([dbAction], "cleanup_test", Date.now());
    assert.equal(result.applied, 1);
    assert.equal(countSoftDeletedMemories(memoryDb, DEFAULT_LIFECYCLE_POLICY), 0);
    memoryDb.close();
  } finally {
    try {
      await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // ignore windows sqlite lock on temp db
    }
  }
}

async function main(): Promise<void> {
  await testSoftDeletedMemories();
  console.log("ok - soft deleted memories");
  await testTraceFieldPrune();
  console.log("ok - trace field prune");
  await testPlannerAndExecutorDbRows();
  console.log("ok - planner executor db rows");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
