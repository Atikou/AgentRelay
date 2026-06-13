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
} from "../src/storage/memoryDbMigrations.js";
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

test("全新 memory.db 应用 v1–v7 并写入 schema_migrations", () => {
  const dataDir = tempDataDir();
  try {
    const dbm = new DatabaseManager(dataDir);
    assert.equal(dbm.schemaVersion, MEMORY_DB_SCHEMA_VERSION);
    assert.equal(dbm.schemaInfo.userVersion, MEMORY_DB_SCHEMA_VERSION);
    assert.equal(dbm.schemaInfo.migrations.length, MEMORY_DB_MIGRATIONS.length);
    assert.equal(dbm.schemaInfo.migrations[0]?.name, "core_sessions_messages_memories");
    assert.equal(dbm.schemaInfo.migrations.at(-1)?.name, "fts_and_routing_tables");

    const row = dbm.connection
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`)
      .get() as { name: string };
    assert.equal(row.name, "schema_migrations");
    dbm.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("全新 tools.db schema version = 1", () => {
  const dataDir = tempDataDir();
  try {
    const storage = new ToolStorage(dataDir);
    assert.equal(storage.schemaVersion, TOOLS_DB_SCHEMA_VERSION);
    assert.equal(storage.schemaInfo.migrations.length, 1);
    assert.equal(storage.schemaInfo.migrations[0]?.name, "tool_logs_file_changes_backups");
    storage.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("旧库无 schema_migrations 时回填审计记录", () => {
  const dataDir = tempDataDir();
  const dbPath = path.join(dataDir, "agent_data", "memory.db");
  try {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
        project_id TEXT, last_message_id TEXT, active_task_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      PRAGMA user_version = 7;
    `);
    db.close();

    const dbm = new DatabaseManager(dataDir);
    assert.equal(dbm.schemaVersion, 7);
    assert.equal(dbm.schemaInfo.migrations.length, MEMORY_DB_MIGRATIONS.length);
    assert.equal(getUserVersion(dbm.connection), 7);
    dbm.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("重复打开不重复应用迁移", () => {
  const dataDir = tempDataDir();
  try {
    const first = new DatabaseManager(dataDir);
    const count1 = first.schemaInfo.migrations.length;
    first.close();
    const second = new DatabaseManager(dataDir);
    assert.equal(second.schemaInfo.migrations.length, count1);
    second.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
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
    rmSync(path.dirname(dbPath), { recursive: true, force: true });
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
