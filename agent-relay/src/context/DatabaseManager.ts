import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ensureRoutingTables } from "../model-router/route-stores.js";

const SCHEMA_VERSION = 3;

/**
 * SQLite 存储层（Node 内置 node:sqlite，含 FTS5）。
 * 数据目录：{dataDir}/agent_data/memory.db
 */
export class DatabaseManager {
  readonly dbPath: string;
  readonly filesDir: string;
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    const agentData = path.join(dataDir, "agent_data");
    mkdirSync(agentData, { recursive: true });
    mkdirSync(path.join(agentData, "files"), { recursive: true });
    mkdirSync(path.join(agentData, "lancedb"), { recursive: true });
    mkdirSync(path.join(agentData, "logs", "messages"), { recursive: true });

    this.dbPath = path.join(agentData, "memory.db");
    this.filesDir = path.join(agentData, "files");
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  get connection(): DatabaseSync {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        project_id TEXT,
        last_message_id TEXT,
        active_task_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        token_estimate INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

      CREATE TABLE IF NOT EXISTS conversation_summaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project_id TEXT,
        summary_type TEXT NOT NULL,
        content TEXT NOT NULL,
        start_message_id TEXT,
        end_message_id TEXT,
        token_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_summaries_session ON conversation_summaries(session_id, created_at);

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        scope_id TEXT,
        memory_type TEXT NOT NULL,
        key TEXT,
        value TEXT NOT NULL,
        summary TEXT,
        importance REAL NOT NULL DEFAULT 0.5,
        confidence REAL NOT NULL DEFAULT 1.0,
        source TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, scope_id, is_active);

      CREATE TABLE IF NOT EXISTS agent_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        project_id TEXT,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_steps (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        required_permissions_json TEXT NOT NULL,
        needs_confirmation INTEGER NOT NULL DEFAULT 0,
        acceptance TEXT,
        tool TEXT,
        tool_input_json TEXT,
        result TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, step_id),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_steps_task ON task_steps(task_id, position);

      CREATE TABLE IF NOT EXISTS task_step_dependencies (
        task_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        depends_on_step_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(task_id, step_id, depends_on_step_id),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );

      CREATE TABLE IF NOT EXISTS task_attempts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        step_id TEXT,
        run_id TEXT,
        status TEXT NOT NULL,
        error TEXT,
        result TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_attempts_task ON task_attempts(task_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        session_id TEXT,
        task_id TEXT,
        parent_run_id TEXT,
        trigger_id TEXT,
        goal TEXT,
        error TEXT,
        result_json TEXT,
        correlation_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, updated_at DESC);
    `);

    this.addColumnIfMissing("messages", "is_summarized", "is_summarized INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("messages", "summary_id", "summary_id TEXT");
    this.addColumnIfMissing(
      "conversation_summaries",
      "structured_json",
      "structured_json TEXT",
    );
    this.addColumnIfMissing("memories", "source_id", "source_id TEXT");
    this.addColumnIfMissing("memories", "supersedes_id", "supersedes_id TEXT");

    this.ensureFts("messages_fts", "messages", "id", "content");
    this.ensureFts("summaries_fts", "conversation_summaries", "id", "content");
    this.ensureFts("memories_fts", "memories", "id", "value", "summary");
    ensureRoutingTables(this.db);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }

  private addColumnIfMissing(table: string, column: string, ddl: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (!rows.some((r) => r.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  }

  private ensureFts(
    ftsName: string,
    table: string,
    idCol: string,
    ...textCols: string[]
  ): void {
    const exists = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(ftsName) as { name: string } | undefined;
    if (!exists) {
      this.db.exec(`CREATE VIRTUAL TABLE ${ftsName} USING fts5(content, tokenize='unicode61');`);
    }

    const row = this.db
      .prepare(`SELECT value FROM agent_state WHERE key=?`)
      .get(`fts_sync:${ftsName}`) as { value: string } | undefined;
    if (row?.value === "1") return;

    const selectCols = textCols.map((c) => `COALESCE(${c}, '')`).join(" || ' ' || ");
    const rows = this.db
      .prepare(`SELECT ${idCol} AS id, ${selectCols} AS content FROM ${table}`)
      .all() as Array<{ id: string; content: string }>;

    const insert = this.db.prepare(
      `INSERT INTO ${ftsName}(rowid, content) VALUES (?, ?)`,
    );
    for (const r of rows) {
      insert.run(hashRowId(r.id), r.content);
    }
    this.db
      .prepare(
        `INSERT INTO agent_state(key, value, updated_at) VALUES (?, '1', ?)
         ON CONFLICT(key) DO UPDATE SET value='1', updated_at=excluded.updated_at`,
      )
      .run(`fts_sync:${ftsName}`, new Date().toISOString());
  }

  upsertFts(ftsName: string, sourceId: string, content: string): void {
    const rowid = hashRowId(sourceId);
    this.db.prepare(`DELETE FROM ${ftsName} WHERE rowid=?`).run(rowid);
    this.db.prepare(`INSERT INTO ${ftsName}(rowid, content) VALUES (?, ?)`).run(rowid, content);
  }

  deleteFts(ftsName: string, sourceId: string): void {
    this.db.prepare(`DELETE FROM ${ftsName} WHERE rowid=?`).run(hashRowId(sourceId));
  }

  searchFts(ftsName: string, query: string, limit = 10): Array<{ rowid: number; content: string }> {
    const safe = query.replace(/"/g, '""').trim();
    if (!safe) return [];
    try {
      return this.db
        .prepare(
          `SELECT rowid, content FROM ${ftsName} WHERE content MATCH ? LIMIT ?`,
        )
        .all(`"${safe}"* OR ${safe}`, limit) as Array<{ rowid: number; content: string }>;
    } catch {
      return [];
    }
  }
}

/** 将 UUID 映射为稳定正整数 rowid（FTS5 要求整数 rowid）。 */
export function hashRowId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return (h % 2_000_000_000) + 1;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
