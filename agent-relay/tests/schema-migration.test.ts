/**
 * SQLite schema version 与 schema_migrations 审计表自检。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DatabaseManager } from "../src/context/DatabaseManager.js";
import {
  MEMORY_DB_MIGRATIONS,
  MEMORY_DB_SCHEMA_VERSION,
} from "../src/context/memoryDbMigrations.js";
import {
  applySqliteMigrations,
  getUserVersion,
} from "../src/storage/sqliteMigration.js";
import {
  TOOLS_DB_MIGRATIONS,
  TOOLS_DB_SCHEMA_VERSION,
} from "../src/storage/toolsDbMigrations.js";
import { ToolStorage } from "../src/tools/storage/ToolStorage.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

function tempDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), "ar-schema-"));
}

function removeTempDir(dir: string): void {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) {
        const code =
          typeof error === "object" && error && "code" in error
            ? String((error as { code?: unknown }).code)
            : "";
        if (code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY") {
          console.warn(`  ! skipped temp cleanup for locked sqlite file: ${dir}`);
          return;
        }
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

test("v1–v24 全新 memory.db 应用迁移", () => {
  const dataDir = tempDataDir();
  let dbm: DatabaseManager | undefined;
  try {
    dbm = new DatabaseManager(dataDir);
    assert.equal(dbm.schemaVersion, MEMORY_DB_SCHEMA_VERSION);
    assert.equal(dbm.schemaInfo.userVersion, MEMORY_DB_SCHEMA_VERSION);
    assert.equal(dbm.schemaInfo.migrations.length, MEMORY_DB_MIGRATIONS.length);
    assert.equal(dbm.schemaInfo.migrations[0]?.name, "core_sessions_messages_memories");
    assert.equal(dbm.schemaInfo.migrations.at(-1)?.name, "workspace_grants_and_audit");

    const messageCols = dbm.connection
      .prepare(`PRAGMA table_info(messages)`)
      .all() as Array<{ name: string }>;
    assert.ok(messageCols.some((c) => c.name === "client_name"));
    assert.ok(messageCols.some((c) => c.name === "model_name"));
    assert.ok(messageCols.some((c) => c.name === "ledger_backed"));
    assert.ok(messageCols.some((c) => c.name === "outcome_class"));
    assert.ok(messageCols.some((c) => c.name === "outcome_kind"));

    const runStatesTable = dbm.connection
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='run_states'`)
      .get() as { name: string };
    assert.equal(runStatesTable.name, "run_states");

    const projectFilesTable = dbm.connection
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='project_files'`)
      .get() as { name: string };
    assert.equal(projectFilesTable.name, "project_files");

    const evalTable = dbm.connection
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='model_eval_runs'`)
      .get() as { name: string };
    assert.equal(evalTable.name, "model_eval_runs");

    const importsTable = dbm.connection
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='project_imports'`)
      .get() as { name: string };
    assert.equal(importsTable.name, "project_imports");

    const row = dbm.connection
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`)
      .get() as { name: string };
    assert.equal(row.name, "schema_migrations");

    const permissionTable = dbm.connection
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='permission_requests'`)
      .get() as { name: string };
    assert.equal(permissionTable.name, "permission_requests");

    const pausedTable = dbm.connection
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='paused_run_snapshots'`)
      .get() as { name: string };
    assert.equal(pausedTable.name, "paused_run_snapshots");

    const sessionGrantsTable = dbm.connection
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='session_permission_grants'`)
      .get() as { name: string };
    assert.equal(sessionGrantsTable.name, "session_permission_grants");

    const planHandoffsTable = dbm.connection
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='plan_handoffs'`)
      .get() as { name: string };
    assert.equal(planHandoffsTable.name, "plan_handoffs");

    const sessionTaskTable = dbm.connection
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='session_task_contexts'`)
      .get() as { name: string };
    assert.equal(sessionTaskTable.name, "session_task_contexts");

    const workspaceGrantsTable = dbm.connection
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_grants'`)
      .get() as { name: string };
    assert.equal(workspaceGrantsTable.name, "workspace_grants");

    const workspaceAuditTable = dbm.connection
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_access_audit'`)
      .get() as { name: string };
    assert.equal(workspaceAuditTable.name, "workspace_access_audit");

    const sideEffectCol = dbm.connection
      .prepare(`PRAGMA table_info(session_task_contexts)`)
      .all() as Array<{ name: string }>;
    assert.ok(sideEffectCol.some((c) => c.name === "side_effect_summary_json"));

    const entryCol = dbm.connection
      .prepare(`PRAGMA table_info(session_task_contexts)`)
      .all() as Array<{ name: string }>;
    assert.ok(entryCol.some((c) => c.name === "entry_intent"));
    assert.ok(entryCol.some((c) => c.name === "reconciled_workflow_type"));
    assert.ok(entryCol.some((c) => c.name === "last_completion_status"));
  } finally {
    dbm?.close();
    removeTempDir(dataDir);
  }
});

test("全新 tools.db schema version = 1", () => {
  const dataDir = tempDataDir();
  let storage: ToolStorage | undefined;
  try {
    storage = new ToolStorage(dataDir);
    assert.equal(storage.schemaVersion, TOOLS_DB_SCHEMA_VERSION);
    assert.equal(storage.schemaInfo.migrations.length, 1);
    assert.equal(storage.schemaInfo.migrations[0]?.name, "tool_logs_file_changes_backups");
  } finally {
    storage?.close();
    removeTempDir(dataDir);
  }
});

test("旧库无 schema_migrations 时回填审计记录", () => {
  const dataDir = tempDataDir();
  const dbPath = path.join(dataDir, "agent_data", "memory.db");
  let dbm: DatabaseManager | undefined;
  try {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
        project_id TEXT, last_message_id TEXT, active_task_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      PRAGMA user_version = 7;
    `);
    db.close();

    dbm = new DatabaseManager(dataDir);
    assert.equal(dbm.schemaVersion, MEMORY_DB_SCHEMA_VERSION);
    assert.equal(dbm.schemaInfo.migrations.length, MEMORY_DB_MIGRATIONS.length);
    assert.equal(getUserVersion(dbm.connection), MEMORY_DB_SCHEMA_VERSION);
  } finally {
    dbm?.close();
    removeTempDir(dataDir);
  }
});

test("重复打开不重复应用迁移", () => {
  const dataDir = tempDataDir();
  let first: DatabaseManager | undefined;
  let second: DatabaseManager | undefined;
  try {
    first = new DatabaseManager(dataDir);
    const count1 = first.schemaInfo.migrations.length;
    first.close();
    first = undefined;
    second = new DatabaseManager(dataDir);
    assert.equal(second.schemaInfo.migrations.length, count1);
  } finally {
    first?.close();
    second?.close();
    removeTempDir(dataDir);
  }
});

test("applySqliteMigrations 版本断层抛错", () => {
  const dbPath = path.join(tempDataDir(), "gap.db");
  const db = new DatabaseSync(dbPath);
  try {
    assert.throws(
      () =>
        applySqliteMigrations(db, [
          { version: 2, name: "skip_v1", up: () => {} },
        ]),
      /版本断层/,
    );
  } finally {
    db.close();
    removeTempDir(path.dirname(dbPath));
  }
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`  ✓ ${t.name}`);
    passed += 1;
  } catch (error) {
    console.error(`  ✗ ${t.name}\n    ${String(error)}`);
    failed += 1;
  }
}
console.log(`\nschema-migration: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
