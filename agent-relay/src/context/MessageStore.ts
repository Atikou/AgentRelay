import { randomUUID } from "node:crypto";

import type { DatabaseManager } from "./DatabaseManager.js";
import { estimateTokens } from "./DatabaseManager.js";
import { mapMessage, nowIso } from "./storeMappers.js";
import type { MessageRecord } from "./types.js";

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
