import type { SqliteMigration } from "../storage/sqliteMigration.js";

export const COMPANION_DB_SCHEMA_VERSION = 1;

export const COMPANION_DB_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    name: "companion_core_sessions_messages_summaries",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS companion_sessions (
          id TEXT PRIMARY KEY,
          persona_id TEXT NOT NULL,
          title TEXT NOT NULL,
          storage_root TEXT NOT NULL,
          incognito INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_summary_message_id TEXT
        );

        CREATE TABLE IF NOT EXISTS companion_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          status TEXT NOT NULL,
          trusted INTEGER NOT NULL DEFAULT 1,
          memory_eligible INTEGER NOT NULL DEFAULT 1,
          model_name TEXT,
          client_name TEXT,
          storage_root TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          metadata_json TEXT,
          FOREIGN KEY(session_id) REFERENCES companion_sessions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS companion_summaries (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          source_message_start_id TEXT NOT NULL,
          source_message_end_id TEXT NOT NULL,
          summary TEXT NOT NULL,
          topics_json TEXT NOT NULL DEFAULT '[]',
          trust_level TEXT NOT NULL DEFAULT 'generated',
          model_name TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(session_id) REFERENCES companion_sessions(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_companion_sessions_updated
          ON companion_sessions(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_companion_messages_session_created
          ON companion_messages(session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_companion_summaries_session_created
          ON companion_summaries(session_id, created_at);
      `);
    },
  },
];

