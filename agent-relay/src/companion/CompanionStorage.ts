import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  applySqliteMigrations,
  getSchemaInfo,
  type SchemaInfo,
} from "../storage/sqliteMigration.js";
import {
  COMPANION_DB_MIGRATIONS,
  COMPANION_DB_SCHEMA_VERSION,
} from "./companionDbMigrations.js";
import type {
  CompanionMessage,
  CompanionMessageRole,
  CompanionMessageStatus,
  CompanionSession,
  CompanionStorageStatus,
  CompanionSummary,
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function parseJsonObject(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function mapSession(row: {
  id: string;
  persona_id: string;
  title: string;
  storage_root: string;
  incognito: number;
  created_at: string;
  updated_at: string;
  last_summary_message_id: string | null;
}): CompanionSession {
  return {
    id: row.id,
    personaId: row.persona_id,
    title: row.title,
    storageRoot: row.storage_root,
    incognito: row.incognito === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSummaryMessageId: row.last_summary_message_id ?? undefined,
  };
}

function mapMessage(row: {
  id: string;
  session_id: string;
  role: CompanionMessageRole;
  content: string;
  status: CompanionMessageStatus;
  trusted: number;
  memory_eligible: number;
  model_name: string | null;
  client_name: string | null;
  storage_root: string;
  created_at: string;
  updated_at: string;
  metadata_json: string | null;
}): CompanionMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    status: row.status,
    trusted: row.trusted === 1,
    memoryEligible: row.memory_eligible === 1,
    modelName: row.model_name ?? undefined,
    clientName: row.client_name ?? undefined,
    storageRoot: row.storage_root,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJsonObject(row.metadata_json),
  };
}

function mapSummary(row: {
  id: string;
  session_id: string;
  source_message_start_id: string;
  source_message_end_id: string;
  summary: string;
  topics_json: string;
  trust_level: "generated";
  model_name: string | null;
  created_at: string;
}): CompanionSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    sourceMessageStartId: row.source_message_start_id,
    sourceMessageEndId: row.source_message_end_id,
    summary: row.summary,
    topics: parseStringArray(row.topics_json),
    trustLevel: row.trust_level,
    modelName: row.model_name ?? undefined,
    createdAt: row.created_at,
  };
}

export class CompanionStorage {
  readonly storageRoot: string;
  readonly dbPath: string;
  readonly schemaVersion: number;
  readonly schemaInfo: SchemaInfo;
  private readonly db: DatabaseSync;

  constructor(storageRoot: string) {
    this.storageRoot = storageRoot;
    mkdirSync(storageRoot, { recursive: true });
    mkdirSync(path.join(storageRoot, "exports"), { recursive: true });
    this.assertWritable();
    this.dbPath = path.join(storageRoot, "companion.db");
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = DELETE;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    const { version } = applySqliteMigrations(this.db, COMPANION_DB_MIGRATIONS);
    this.schemaVersion = version;
    this.schemaInfo = getSchemaInfo(this.db);
    if (version !== COMPANION_DB_SCHEMA_VERSION) {
      throw new Error(`companion.db schema 版本异常：期望 ${COMPANION_DB_SCHEMA_VERSION}，实际 ${version}`);
    }
  }

  close(): void {
    this.db.close();
  }

  status(): CompanionStorageStatus {
    return {
      storageRoot: this.storageRoot,
      dbPath: this.dbPath,
      schemaVersion: this.schemaVersion,
      writable: true,
    };
  }

  createSession(input?: {
    id?: string;
    personaId?: string;
    title?: string;
    incognito?: boolean;
  }): CompanionSession {
    const id = input?.id ?? crypto.randomUUID();
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO companion_sessions
          (id, persona_id, title, storage_root, incognito, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input?.personaId ?? "default",
        input?.title ?? "纯聊天会话",
        this.storageRoot,
        input?.incognito ? 1 : 0,
        at,
        at,
      );
    return this.getSession(id)!;
  }

  getSession(id: string): CompanionSession | null {
    const row = this.db
      .prepare(`SELECT * FROM companion_sessions WHERE id=?`)
      .get(id) as Parameters<typeof mapSession>[0] | undefined;
    return row ? mapSession(row) : null;
  }

  listSessions(limit = 50): CompanionSession[] {
    const rows = this.db
      .prepare(`SELECT * FROM companion_sessions ORDER BY updated_at DESC LIMIT ?`)
      .all(limit) as Array<Parameters<typeof mapSession>[0]>;
    return rows.map(mapSession);
  }

  touchSession(sessionId: string, patch?: { title?: string; lastSummaryMessageId?: string }): void {
    const at = nowIso();
    if (patch?.title !== undefined) {
      this.db
        .prepare(`UPDATE companion_sessions SET title=?, updated_at=? WHERE id=?`)
        .run(patch.title, at, sessionId);
      return;
    }
    if (patch?.lastSummaryMessageId !== undefined) {
      this.db
        .prepare(`UPDATE companion_sessions SET last_summary_message_id=?, updated_at=? WHERE id=?`)
        .run(patch.lastSummaryMessageId, at, sessionId);
      return;
    }
    this.db.prepare(`UPDATE companion_sessions SET updated_at=? WHERE id=?`).run(at, sessionId);
  }

  createMessage(input: {
    sessionId: string;
    role: CompanionMessageRole;
    content: string;
    status?: CompanionMessageStatus;
    trusted?: boolean;
    memoryEligible?: boolean;
    modelName?: string;
    clientName?: string;
    metadata?: Record<string, unknown>;
  }): CompanionMessage {
    const id = crypto.randomUUID();
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO companion_messages
          (id, session_id, role, content, status, trusted, memory_eligible, model_name, client_name, storage_root, created_at, updated_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.role,
        input.content,
        input.status ?? "completed",
        input.trusted === false ? 0 : 1,
        input.memoryEligible === false ? 0 : 1,
        input.modelName ?? null,
        input.clientName ?? null,
        this.storageRoot,
        at,
        at,
        input.metadata ? JSON.stringify(input.metadata) : null,
      );
    this.touchSession(input.sessionId);
    return this.getMessage(id)!;
  }

  getMessage(id: string): CompanionMessage | null {
    const row = this.db
      .prepare(`SELECT * FROM companion_messages WHERE id=?`)
      .get(id) as Parameters<typeof mapMessage>[0] | undefined;
    return row ? mapMessage(row) : null;
  }

  updateMessage(
    id: string,
    patch: {
      content?: string;
      status?: CompanionMessageStatus;
      modelName?: string;
      clientName?: string;
      metadata?: Record<string, unknown>;
    },
  ): CompanionMessage | null {
    const current = this.getMessage(id);
    if (!current) return null;
    const at = nowIso();
    this.db
      .prepare(
        `UPDATE companion_messages
         SET content=?, status=?, model_name=?, client_name=?, updated_at=?, metadata_json=?
         WHERE id=?`,
      )
      .run(
        patch.content ?? current.content,
        patch.status ?? current.status,
        patch.modelName ?? current.modelName ?? null,
        patch.clientName ?? current.clientName ?? null,
        at,
        patch.metadata ? JSON.stringify(patch.metadata) : current.metadata ? JSON.stringify(current.metadata) : null,
        id,
      );
    this.touchSession(current.sessionId);
    return this.getMessage(id);
  }

  listMessages(sessionId: string, limit = 80): CompanionMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM companion_messages
           WHERE session_id=? AND status != 'deleted'
           ORDER BY created_at DESC
           LIMIT ?
         ) ORDER BY created_at ASC`,
      )
      .all(sessionId, limit) as Array<Parameters<typeof mapMessage>[0]>;
    return rows.map(mapMessage);
  }

  createSummary(input: {
    sessionId: string;
    sourceMessageStartId: string;
    sourceMessageEndId: string;
    summary: string;
    topics?: string[];
    modelName?: string;
  }): CompanionSummary {
    const id = crypto.randomUUID();
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO companion_summaries
          (id, session_id, source_message_start_id, source_message_end_id, summary, topics_json, trust_level, model_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'generated', ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.sourceMessageStartId,
        input.sourceMessageEndId,
        input.summary,
        JSON.stringify(input.topics ?? []),
        input.modelName ?? null,
        at,
      );
    this.touchSession(input.sessionId, { lastSummaryMessageId: input.sourceMessageEndId });
    return this.getSummary(id)!;
  }

  getSummary(id: string): CompanionSummary | null {
    const row = this.db
      .prepare(`SELECT * FROM companion_summaries WHERE id=?`)
      .get(id) as Parameters<typeof mapSummary>[0] | undefined;
    return row ? mapSummary(row) : null;
  }

  listSummaries(sessionId: string, limit = 6): CompanionSummary[] {
    const rows = this.db
      .prepare(`SELECT * FROM companion_summaries WHERE session_id=? ORDER BY created_at DESC LIMIT ?`)
      .all(sessionId, limit) as Array<Parameters<typeof mapSummary>[0]>;
    return rows.map(mapSummary).reverse();
  }

  private assertWritable(): void {
    const probe = path.join(this.storageRoot, `.write-probe-${process.pid}-${Date.now()}`);
    writeFileSync(probe, "ok", "utf-8");
    rmSync(probe, { force: true });
  }
}
