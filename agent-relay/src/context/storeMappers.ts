import type { MessageRecord, SessionRecord } from "./types.js";
import type { MessageKind, MessageSource } from "./messageEnvelope.js";
import { inferEnvelopeFromLegacy } from "./messageEnvelope.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function mapSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    status: row.status === "archived" ? "archived" : "active",
    projectId: row.project_id ? String(row.project_id) : undefined,
    workspaceKey: row.workspace_key ? String(row.workspace_key) : undefined,
    lastMessageId: row.last_message_id ? String(row.last_message_id) : undefined,
    activeTaskId: row.active_task_id ? String(row.active_task_id) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function mapMessage(row: Record<string, unknown>): MessageRecord {
  const role = String(row.role);
  const content = String(row.content);
  const messageKind = row.message_kind ? (String(row.message_kind) as MessageKind) : undefined;
  const inferred = messageKind ? undefined : inferEnvelopeFromLegacy(role, content);
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    role,
    content,
    tokenEstimate: Number(row.token_estimate ?? 0),
    isSummarized: Number(row.is_summarized ?? 0) === 1,
    summaryId: row.summary_id ? String(row.summary_id) : undefined,
    clientName: row.client_name ? String(row.client_name) : undefined,
    modelName: row.model_name ? String(row.model_name) : undefined,
    messageKind: messageKind ?? inferred?.messageKind,
    uiVisible:
      row.ui_visible != null
        ? Number(row.ui_visible) === 1
        : inferred?.uiVisible,
    trusted:
      row.trusted != null ? Number(row.trusted) === 1 : inferred?.trusted,
    source: row.source
      ? (String(row.source) as MessageSource)
      : inferred?.source,
    runId: row.run_id ? String(row.run_id) : undefined,
    createdAt: String(row.created_at),
  };
}
