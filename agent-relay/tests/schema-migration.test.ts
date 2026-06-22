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
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

test("全新 memory.db 应用 v1–v14 并写入 schema_migrations", () => {
  const dataDir = tempDataDir();
  let dbm: DatabaseManager | undefined;
  try {
    dbm = new DatabaseManager(dataDir);
    assert.equal(dbm.schemaVersion, MEMORY_DB_SCHEMA_VERSION);
    assert.equal(dbm.schemaInfo.userVersion, MEMORY_DB_SCHEMA_VERSION);
    assert.equal(dbm.schemaInfo.migrations.length, MEMORY_DB_MIGRATIONS.length);
    assert.equal(dbm.schemaInfo.migrations[0]?.name, "core_sessions_messages_memories");
    assert.equal(dbm.schemaInfo.migrations.at(-1)?.name, "durable_permission_pauses");

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
