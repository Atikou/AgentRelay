import { randomUUID } from "node:crypto";

import type { DatabaseManager } from "./DatabaseManager.js";
import { estimateTokens } from "./DatabaseManager.js";
import type {
  MemoryRecord,
  MemoryScope,
  MemoryType,
  MessageRecord,
  ProjectRecord,
  SessionRecord,
  StructuredSummary,
  SummaryRecord,
  SummaryType,
  TaskRecord,
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function parseSummary(content: string): StructuredSummary {
  try {
    return JSON.parse(content) as StructuredSummary;
  } catch {
    return { current_goal: content };
  }
}

export class SessionStore {
  constructor(private readonly db: DatabaseManager) {}

  create(title = "新会话", projectId?: string): SessionRecord {
    const id = randomUUID();
    const ts = nowIso();
    this.db.connection
      .prepare(
        `INSERT INTO sessions(id, title, status, project_id, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?, ?)`,
      )
      .run(id, title, projectId ?? null, ts, ts);
    return this.get(id)!;
  }

  get(id: string): SessionRecord | null {
    const row = this.db.connection
      .prepare(`SELECT * FROM sessions WHERE id=?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapSession(row) : null;
  }

  list(limit = 50): SessionRecord[] {
    const rows = this.db.connection
      .prepare(`SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map(mapSession);
  }

  touch(id: string, lastMessageId?: string): void {
    this.db.connection
      .prepare(`UPDATE sessions SET updated_at=?, last_message_id=COALESCE(?, last_message_id) WHERE id=?`)
      .run(nowIso(), lastMessageId ?? null, id);
  }
}

export class MessageStore {
  constructor(private readonly db: DatabaseManager) {}

  append(sessionId: string, role: string, content: string): MessageRecord {
    const id = randomUUID();
    const ts = nowIso();
    const tokens = estimateTokens(content);
    this.db.connection
      .prepare(
        `INSERT INTO messages(id, session_id, role, content, token_estimate, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sessionId, role, content, tokens, ts);
    this.db.upsertFts("messages_fts", id, content);
    return {
      id,
      sessionId,
      role,
      content,
      tokenEstimate: tokens,
      isSummarized: false,
      createdAt: ts,
    };
  }

  markSummarized(messageIds: string[], summaryId: string): void {
    if (messageIds.length === 0) return;
    const stmt = this.db.connection.prepare(
      `UPDATE messages SET is_summarized=1, summary_id=? WHERE id=?`,
    );
    for (const id of messageIds) {
      stmt.run(summaryId, id);
    }
  }

  listBySession(sessionId: string, limit = 500): MessageRecord[] {
    const rows = this.db.connection
      .prepare(
        `SELECT * FROM messages WHERE session_id=? ORDER BY created_at ASC LIMIT ?`,
      )
      .all(sessionId, limit) as Record<string, unknown>[];
    return rows.map(mapMessage);
  }

  listRecent(sessionId: string, count: number): MessageRecord[] {
    const rows = this.db.connection
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages WHERE session_id=? ORDER BY created_at DESC LIMIT ?
         ) ORDER BY created_at ASC`,
      )
      .all(sessionId, count) as Record<string, unknown>[];
    return rows.map(mapMessage);
  }

  countInSession(sessionId: string): number {
    const row = this.db.connection
      .prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_id=?`)
      .get(sessionId) as { c: number };
    return row.c;
  }

  getRange(sessionId: string, startId: string, endId: string): MessageRecord[] {
    const rows = this.db.connection
      .prepare(
        `SELECT * FROM messages
         WHERE session_id=? AND created_at >= (SELECT created_at FROM messages WHERE id=?)
           AND created_at <= (SELECT created_at FROM messages WHERE id=?)
         ORDER BY created_at ASC`,
      )
      .all(sessionId, startId, endId) as Record<string, unknown>[];
    return rows.map(mapMessage);
  }

  getUnsummarized(sessionId: string, summarizedEndId?: string): MessageRecord[] {
    const rows = this.db.connection
      .prepare(
        `SELECT * FROM messages WHERE session_id=? AND is_summarized=0 ORDER BY created_at ASC`,
      )
      .all(sessionId) as Record<string, unknown>[];
    const unsummarized = rows.map(mapMessage);
    if (!summarizedEndId) return unsummarized;
    const row = this.db.connection
      .prepare(`SELECT created_at FROM messages WHERE id=?`)
      .get(summarizedEndId) as { created_at: string } | undefined;
    if (!row) return unsummarized;
    return unsummarized.filter((m) => m.createdAt > row.created_at);
  }

  getRecentUnsummarized(sessionId: string, limit: number): MessageRecord[] {
    const rows = this.db.connection
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages WHERE session_id=? AND is_summarized=0
           ORDER BY created_at DESC LIMIT ?
         ) ORDER BY created_at ASC`,
      )
      .all(sessionId, limit) as Record<string, unknown>[];
    return rows.map(mapMessage);
  }

  listRecentByRole(sessionId: string, role: string, limit: number): MessageRecord[] {
    const rows = this.db.connection
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages WHERE session_id=? AND role=?
           ORDER BY created_at DESC LIMIT ?
         ) ORDER BY created_at ASC`,
      )
      .all(sessionId, role, limit) as Record<string, unknown>[];
    return rows.map(mapMessage);
  }
}

export class SummaryStore {
  constructor(private readonly db: DatabaseManager) {}

  save(input: {
    sessionId: string;
    projectId?: string;
    summaryType: SummaryType;
    content: StructuredSummary;
    startMessageId?: string;
    endMessageId?: string;
    tokenCount?: number;
  }): SummaryRecord {
    const id = randomUUID();
    const ts = nowIso();
    const json = JSON.stringify(input.content);
    const tokens = input.tokenCount ?? estimateTokens(json);
    this.db.connection
      .prepare(
        `INSERT INTO conversation_summaries
         (id, session_id, project_id, summary_type, content, structured_json, start_message_id, end_message_id, token_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.projectId ?? null,
        input.summaryType,
        json,
        json,
        input.startMessageId ?? null,
        input.endMessageId ?? null,
        tokens,
        ts,
        ts,
      );
    this.db.upsertFts("summaries_fts", id, json);
    return {
      id,
      sessionId: input.sessionId,
      projectId: input.projectId,
      summaryType: input.summaryType,
      content: input.content,
      contentText: json,
      structuredJson: json,
      startMessageId: input.startMessageId,
      endMessageId: input.endMessageId,
      tokenCount: tokens,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  latestByType(sessionId: string, summaryType: SummaryType): SummaryRecord | null {
    const row = this.db.connection
      .prepare(
        `SELECT * FROM conversation_summaries
         WHERE session_id=? AND summary_type=?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sessionId, summaryType) as Record<string, unknown> | undefined;
    return row ? mapSummary(row) : null;
  }

  listBySession(sessionId: string): SummaryRecord[] {
    const rows = this.db.connection
      .prepare(
        `SELECT * FROM conversation_summaries WHERE session_id=? ORDER BY created_at ASC`,
      )
      .all(sessionId) as Record<string, unknown>[];
    return rows.map(mapSummary);
  }

  lastChunkEndMessageId(sessionId: string): string | undefined {
    const row = this.db.connection
      .prepare(
        `SELECT end_message_id FROM conversation_summaries
         WHERE session_id=? AND summary_type='chunk_summary' AND end_message_id IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sessionId) as { end_message_id: string | null } | undefined;
    return row?.end_message_id ?? undefined;
  }
}

export class MemoryStore {
  constructor(private readonly db: DatabaseManager) {}

  upsert(input: {
    scope: MemoryScope;
    scopeId?: string;
    memoryType: MemoryType;
    key?: string;
    value: string;
    summary?: string;
    importance?: number;
    confidence?: number;
    source?: string;
    sourceId?: string;
  }): MemoryRecord {
    const ts = nowIso();
    const existing = this.findExisting(input);
    if (existing) {
      this.db.connection
        .prepare(
          `UPDATE memories
           SET value=?, summary=?, importance=?, confidence=?, source=?, source_id=?, is_active=1, updated_at=?
           WHERE id=?`,
        )
        .run(
          input.value,
          input.summary ?? null,
          input.importance ?? existing.importance,
          input.confidence ?? existing.confidence,
          input.source ?? existing.source ?? null,
          input.sourceId ?? existing.sourceId ?? null,
          ts,
          existing.id,
        );
      const ftsText = [input.value, input.summary ?? "", input.key ?? ""].join(" ");
      this.db.upsertFts("memories_fts", existing.id, ftsText);
      return this.get(existing.id)!;
    }

    const id = randomUUID();
    this.db.connection
      .prepare(
        `INSERT INTO memories
         (id, scope, scope_id, memory_type, key, value, summary, importance, confidence, source, source_id, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        input.scope,
        input.scopeId ?? null,
        input.memoryType,
        input.key ?? null,
        input.value,
        input.summary ?? null,
        input.importance ?? 0.5,
        input.confidence ?? 1,
        input.source ?? null,
        input.sourceId ?? null,
        ts,
        ts,
      );
    const ftsText = [input.value, input.summary ?? "", input.key ?? ""].join(" ");
    this.db.upsertFts("memories_fts", id, ftsText);
    return this.get(id)!;
  }

  get(id: string): MemoryRecord | null {
    const row = this.db.connection
      .prepare(`SELECT * FROM memories WHERE id=?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapMemory(row) : null;
  }

  listActive(scope: MemoryScope, scopeId?: string, limit = 20): MemoryRecord[] {
    const rows = scopeId
      ? (this.db.connection
          .prepare(
            `SELECT * FROM memories WHERE scope=? AND scope_id=? AND is_active=1
             ORDER BY importance DESC, updated_at DESC LIMIT ?`,
          )
          .all(scope, scopeId, limit) as Record<string, unknown>[])
      : (this.db.connection
          .prepare(
            `SELECT * FROM memories WHERE scope=? AND is_active=1
             ORDER BY importance DESC, updated_at DESC LIMIT ?`,
          )
          .all(scope, limit) as Record<string, unknown>[]);
    return dedupeMemories(rows.map(mapMemory));
  }

  listByType(
    scope: MemoryScope,
    scopeId: string | undefined,
    memoryType: MemoryType,
    limit = 10,
  ): MemoryRecord[] {
    const rows = scopeId
      ? (this.db.connection
          .prepare(
            `SELECT * FROM memories WHERE scope=? AND scope_id=? AND memory_type=? AND is_active=1
             ORDER BY importance DESC, updated_at DESC LIMIT ?`,
          )
          .all(scope, scopeId, memoryType, limit) as Record<string, unknown>[])
      : (this.db.connection
          .prepare(
            `SELECT * FROM memories WHERE scope=? AND memory_type=? AND is_active=1
             ORDER BY importance DESC, updated_at DESC LIMIT ?`,
          )
          .all(scope, memoryType, limit) as Record<string, unknown>[]);
    return dedupeMemories(rows.map(mapMemory));
  }

  searchActive(query: string, limit = 10): MemoryRecord[] {
    const safe = `%${query.replace(/[%_]/g, "")}%`;
    const rows = this.db.connection
      .prepare(
        `SELECT * FROM memories WHERE is_active=1
         AND (value LIKE ? OR COALESCE(summary, '') LIKE ? OR COALESCE(key, '') LIKE ?)
         ORDER BY importance DESC, updated_at DESC LIMIT ?`,
      )
      .all(safe, safe, safe, limit) as Record<string, unknown>[];
    return dedupeMemories(rows.map(mapMemory));
  }

  deactivate(id: string): void {
    this.db.connection
      .prepare(`UPDATE memories SET is_active=0, updated_at=? WHERE id=?`)
      .run(nowIso(), id);
    this.db.deleteFts("memories_fts", id);
  }

  touchUsed(id: string): void {
    const ts = nowIso();
    this.db.connection
      .prepare(`UPDATE memories SET last_used_at=?, updated_at=? WHERE id=?`)
      .run(ts, ts, id);
  }

  private findExisting(input: {
    scope: MemoryScope;
    scopeId?: string;
    memoryType: MemoryType;
    key?: string;
    value: string;
  }): MemoryRecord | null {
    const scopeId = input.scopeId ?? null;
    const trimmedKey = input.key?.trim();
    const row = trimmedKey
      ? (this.db.connection
          .prepare(
            `SELECT * FROM memories
             WHERE scope=? AND COALESCE(scope_id, '')=COALESCE(?, '') AND memory_type=?
               AND key=? AND is_active=1
             ORDER BY updated_at DESC LIMIT 1`,
          )
          .get(input.scope, scopeId, input.memoryType, trimmedKey) as
          | Record<string, unknown>
          | undefined)
      : (this.db.connection
          .prepare(
            `SELECT * FROM memories
             WHERE scope=? AND COALESCE(scope_id, '')=COALESCE(?, '') AND memory_type=?
               AND key IS NULL AND value=? AND is_active=1
             ORDER BY updated_at DESC LIMIT 1`,
          )
          .get(input.scope, scopeId, input.memoryType, input.value) as
          | Record<string, unknown>
          | undefined);
    return row ? mapMemory(row) : null;
  }
}

function dedupeMemories(memories: MemoryRecord[]): MemoryRecord[] {
  const seen = new Set<string>();
  const out: MemoryRecord[] = [];
  for (const memory of memories) {
    const signature = [
      memory.scope,
      memory.scopeId ?? "",
      memory.memoryType,
      memory.key?.trim() || memory.value.trim(),
    ].join("\u0000");
    if (seen.has(signature)) continue;
    seen.add(signature);
    out.push(memory);
  }
  return out;
}

function mapSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    status: row.status === "archived" ? "archived" : "active",
    projectId: row.project_id ? String(row.project_id) : undefined,
    lastMessageId: row.last_message_id ? String(row.last_message_id) : undefined,
    activeTaskId: row.active_task_id ? String(row.active_task_id) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapMessage(row: Record<string, unknown>): MessageRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    role: String(row.role),
    content: String(row.content),
    tokenEstimate: Number(row.token_estimate ?? 0),
    isSummarized: Number(row.is_summarized ?? 0) === 1,
    summaryId: row.summary_id ? String(row.summary_id) : undefined,
    createdAt: String(row.created_at),
  };
}

function mapSummary(row: Record<string, unknown>): SummaryRecord {
  const raw = String(row.content);
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    projectId: row.project_id ? String(row.project_id) : undefined,
    summaryType: String(row.summary_type) as SummaryType,
    content: parseSummary(raw),
    contentText: raw,
    structuredJson: row.structured_json ? String(row.structured_json) : raw,
    startMessageId: row.start_message_id ? String(row.start_message_id) : undefined,
    endMessageId: row.end_message_id ? String(row.end_message_id) : undefined,
    tokenCount: Number(row.token_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapMemory(row: Record<string, unknown>): MemoryRecord {
  return {
    id: String(row.id),
    scope: String(row.scope) as MemoryScope,
    scopeId: row.scope_id ? String(row.scope_id) : undefined,
    memoryType: String(row.memory_type) as MemoryType,
    key: row.key ? String(row.key) : undefined,
    value: String(row.value),
    summary: row.summary ? String(row.summary) : undefined,
    importance: Number(row.importance ?? 0.5),
    confidence: Number(row.confidence ?? 1),
    source: row.source ? String(row.source) : undefined,
    sourceId: row.source_id ? String(row.source_id) : undefined,
    isActive: Number(row.is_active) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : undefined,
    expiresAt: row.expires_at ? String(row.expires_at) : undefined,
    supersedesId: row.supersedes_id ? String(row.supersedes_id) : undefined,
  };
}

export class ProjectStore {
  constructor(private readonly db: DatabaseManager) {}

  create(name: string, rootPath?: string, description?: string): ProjectRecord {
    const id = randomUUID();
    const ts = nowIso();
    this.db.connection
      .prepare(
        `INSERT INTO projects(id, name, root_path, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, name, rootPath ?? null, description ?? null, ts, ts);
    return this.get(id)!;
  }

  get(id: string): ProjectRecord | null {
    const row = this.db.connection
      .prepare(`SELECT * FROM projects WHERE id=?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapProject(row) : null;
  }

  list(limit = 50): ProjectRecord[] {
    const rows = this.db.connection
      .prepare(`SELECT * FROM projects ORDER BY updated_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map(mapProject);
  }
}

export class TaskStore {
  constructor(private readonly db: DatabaseManager) {}

  get(id: string): TaskRecord | null {
    const row = this.db.connection
      .prepare(`SELECT * FROM tasks WHERE id=?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapTask(row) : null;
  }

  getActiveForSession(sessionId: string): TaskRecord | null {
    const row = this.db.connection
      .prepare(
        `SELECT * FROM tasks WHERE session_id=? AND status != 'done'
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? mapTask(row) : null;
  }
}

function mapProject(row: Record<string, unknown>): ProjectRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    rootPath: row.root_path ? String(row.root_path) : undefined,
    description: row.description ? String(row.description) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapTask(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
    sessionId: row.session_id ? String(row.session_id) : undefined,
    projectId: row.project_id ? String(row.project_id) : undefined,
    goal: String(row.goal),
    status: String(row.status),
    summary: row.summary ? String(row.summary) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
