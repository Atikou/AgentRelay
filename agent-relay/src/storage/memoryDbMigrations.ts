import type { DatabaseSync } from "node:sqlite";

import { hashRowId } from "./sqliteMigration.js";
import { ensureRoutingTables } from "../model-router/route-stores.js";
import { addColumnIfMissing, type SqliteMigration } from "./sqliteMigration.js";

export const MEMORY_DB_SCHEMA_VERSION = 7;

function ensureFts(
  db: DatabaseSync,
  ftsName: string,
  table: string,
  idCol: string,
  textCols: string[],
): void {
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(ftsName) as { name: string } | undefined;
  if (!exists) {
    db.exec(`CREATE VIRTUAL TABLE ${ftsName} USING fts5(content, tokenize='unicode61');`);
  }

  const row = db
    .prepare(`SELECT value FROM agent_state WHERE key=?`)
    .get(`fts_sync:${ftsName}`) as { value: string } | undefined;
  if (row?.value === "1") return;

  const selectCols = textCols.map((c) => `COALESCE(${c}, '')`).join(" || ' ' || ");
  const rows = db
    .prepare(`SELECT ${idCol} AS id, ${selectCols} AS content FROM ${table}`)
    .all() as Array<{ id: string; content: string }>;

  const insert = db.prepare(`INSERT INTO ${ftsName}(rowid, content) VALUES (?, ?)`);
  for (const r of rows) {
    insert.run(hashRowId(r.id), r.content);
  }
  db
    .prepare(
      `INSERT INTO agent_state(key, value, updated_at) VALUES (?, '1', ?)
       ON CONFLICT(key) DO UPDATE SET value='1', updated_at=excluded.updated_at`,
    )
    .run(`fts_sync:${ftsName}`, new Date().toISOString());
}

/** memory.db 递增迁移（v1–v7）；每步须幂等。 */
export const MEMORY_DB_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    name: "core_sessions_messages_memories",
    up(db) {
      db.exec(`
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
      `);
    },
  },
  {
    version: 2,
    name: "tasks_and_steps",
    up(db) {
      db.exec(`
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
      `);
    },
  },
  {
    version: 3,
    name: "projects_and_runs",
    up(db) {
      db.exec(`
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
    },
  },
  {
    version: 4,
    name: "internal_task_plans",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_plans (
          id TEXT PRIMARY KEY,
          version INTEGER NOT NULL,
          status TEXT NOT NULL,
          kind TEXT NOT NULL,
          goal TEXT NOT NULL,
          mode TEXT NOT NULL,
          internal_json TEXT NOT NULL,
          plan_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS task_plan_versions (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          internal_json TEXT NOT NULL,
          plan_hash TEXT NOT NULL,
          change_reason TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(plan_id, version)
        );
        CREATE INDEX IF NOT EXISTS idx_plan_versions_plan ON task_plan_versions(plan_id, version);

        CREATE TABLE IF NOT EXISTS task_plan_previews (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          format TEXT NOT NULL,
          content TEXT NOT NULL,
          source_plan_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_plan_previews_plan ON task_plan_previews(plan_id, version, format);

        CREATE TABLE IF NOT EXISTS task_plan_approvals (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          approved_by TEXT NOT NULL,
          approval_status TEXT NOT NULL,
          comment TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS task_plan_runs (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          stop_reason TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_plan_runs_plan ON task_plan_runs(plan_id, created_at DESC);
      `);
    },
  },
  {
    version: 5,
    name: "user_visible_plans",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_visible_plans (
          id TEXT PRIMARY KEY,
          source_run_id TEXT NOT NULL,
          session_id TEXT,
          title TEXT NOT NULL,
          markdown TEXT NOT NULL,
          todos_json TEXT NOT NULL,
          risks_json TEXT NOT NULL,
          requires_user_confirmation INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_user_visible_plans_run ON user_visible_plans(source_run_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_user_visible_plans_session ON user_visible_plans(session_id, created_at DESC);
      `);
    },
  },
  {
    version: 6,
    name: "column_extensions",
    up(db) {
      addColumnIfMissing(db, "messages", "is_summarized", "is_summarized INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "messages", "summary_id", "summary_id TEXT");
      addColumnIfMissing(db, "conversation_summaries", "structured_json", "structured_json TEXT");
      addColumnIfMissing(db, "memories", "source_id", "source_id TEXT");
      addColumnIfMissing(db, "memories", "supersedes_id", "supersedes_id TEXT");
      addColumnIfMissing(db, "tasks", "inputs_json", "inputs_json TEXT");
      addColumnIfMissing(db, "tasks", "outputs_json", "outputs_json TEXT");
      addColumnIfMissing(db, "tasks", "acceptance_criteria_json", "acceptance_criteria_json TEXT");
      addColumnIfMissing(db, "task_steps", "objective", "objective TEXT");
      addColumnIfMissing(db, "task_steps", "required_context_json", "required_context_json TEXT");
      addColumnIfMissing(db, "task_steps", "available_tools_json", "available_tools_json TEXT");
      addColumnIfMissing(db, "task_steps", "expected_artifacts_json", "expected_artifacts_json TEXT");
      addColumnIfMissing(db, "task_steps", "priority", "priority INTEGER NOT NULL DEFAULT 100");
    },
  },
  {
    version: 7,
    name: "fts_and_routing_tables",
    up(db) {
      ensureFts(db, "messages_fts", "messages", "id", ["content"]);
      ensureFts(db, "summaries_fts", "conversation_summaries", "id", ["content"]);
      ensureFts(db, "memories_fts", "memories", "id", ["value", "summary"]);
      ensureRoutingTables(db);
    },
  },
];
