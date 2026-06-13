import type { MessageRecord, SessionRecord } from "./types.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function mapSession(row: Record<string, unknown>): SessionRecord {
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

export function mapMessage(row: Record<string, unknown>): MessageRecord {
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
