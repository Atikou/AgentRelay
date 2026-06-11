import { randomUUID } from "node:crypto";

import type { DatabaseSync } from "node:sqlite";

import type { RouterDecision } from "./types.js";

function preview(text: string, max = 500): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export class RouteLogStore {
  constructor(private readonly db: DatabaseSync) {}

  save(decision: RouterDecision, userInputPreview: string): void {
    this.db
      .prepare(
        `INSERT INTO model_route_logs (
          id, session_id, project_id, user_input_preview, task_type, selected_level,
          execution_strategy, selected_model_id, draft_model_id, review_model_id, final_model_id,
          risk, reason, source, candidates_json, require_user_confirmation, fallback_note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.id,
        decision.sessionId ?? null,
        decision.projectId ?? null,
        preview(userInputPreview),
        decision.taskType,
        decision.selectedLevel,
        decision.executionStrategy,
        decision.selectedModelId ?? null,
        decision.draftModelId ?? null,
        decision.reviewModelId ?? null,
        decision.finalModelId ?? null,
        decision.risk,
        decision.reason,
        decision.source,
        JSON.stringify(decision.candidates),
        decision.requireUserConfirmation ? 1 : 0,
        decision.fallbackNote ?? null,
        decision.createdAt,
      );
  }
}

export interface ModelCallLogRow {
  id: string;
  routeLogId?: string;
  collaborationRunId?: string;
  sessionId?: string;
  modelId: string;
  role: string;
  inputPreview?: string;
  outputPreview?: string;
  status: "ok" | "error";
  errorMessage?: string;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  createdAt: string;
}

export class ModelCallLogStore {
  constructor(private readonly db: DatabaseSync) {}

  create(row: Omit<ModelCallLogRow, "id" | "createdAt">): string {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO model_call_logs (
          id, route_log_id, collaboration_run_id, session_id, model_id, role,
          input_preview, output_preview, status, error_message,
          prompt_tokens, completion_tokens, duration_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        row.routeLogId ?? null,
        row.collaborationRunId ?? null,
        row.sessionId ?? null,
        row.modelId,
        row.role,
        row.inputPreview ?? null,
        row.outputPreview ?? null,
        row.status,
        row.errorMessage ?? null,
        row.promptTokens ?? null,
        row.completionTokens ?? null,
        row.durationMs ?? null,
        createdAt,
      );
    return id;
  }

  listByRoute(routeLogId: string): ModelCallLogRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM model_call_logs WHERE route_log_id = ? ORDER BY created_at`)
      .all(routeLogId) as Array<Record<string, unknown>>;
    return rows.map(mapCallRow);
  }
}

export interface CollaborationRunRow {
  id: string;
  sessionId?: string;
  projectId?: string;
  routeLogId?: string;
  strategy: string;
  draftModelId?: string;
  reviewModelId?: string;
  finalModelId?: string;
  verdict?: string;
  confidence?: number;
  issuesJson?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export class CollaborationRunStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: {
    sessionId?: string;
    projectId?: string;
    routeLogId?: string;
    strategy: string;
    draftModelId?: string;
    reviewModelId?: string;
    finalModelId?: string;
  }): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO model_collaboration_runs (
          id, session_id, project_id, route_log_id, strategy,
          draft_model_id, review_model_id, final_model_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId ?? null,
        input.projectId ?? null,
        input.routeLogId ?? null,
        input.strategy,
        input.draftModelId ?? null,
        input.reviewModelId ?? null,
        input.finalModelId ?? null,
        "running",
        now,
        now,
      );
    return id;
  }

  finish(
    id: string,
    patch: {
      verdict?: string;
      confidence?: number;
      issuesJson?: string;
      status: string;
    },
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE model_collaboration_runs SET
          verdict = COALESCE(?, verdict),
          confidence = COALESCE(?, confidence),
          issues_json = COALESCE(?, issues_json),
          status = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(
        patch.verdict ?? null,
        patch.confidence ?? null,
        patch.issuesJson ?? null,
        patch.status,
        now,
        id,
      );
  }
}

function mapCallRow(r: Record<string, unknown>): ModelCallLogRow {
  return {
    id: String(r.id),
    routeLogId: r.route_log_id ? String(r.route_log_id) : undefined,
    collaborationRunId: r.collaboration_run_id ? String(r.collaboration_run_id) : undefined,
    sessionId: r.session_id ? String(r.session_id) : undefined,
    modelId: String(r.model_id),
    role: String(r.role),
    inputPreview: r.input_preview ? String(r.input_preview) : undefined,
    outputPreview: r.output_preview ? String(r.output_preview) : undefined,
    status: r.status === "error" ? "error" : "ok",
    errorMessage: r.error_message ? String(r.error_message) : undefined,
    promptTokens: r.prompt_tokens != null ? Number(r.prompt_tokens) : undefined,
    completionTokens: r.completion_tokens != null ? Number(r.completion_tokens) : undefined,
    durationMs: r.duration_ms != null ? Number(r.duration_ms) : undefined,
    createdAt: String(r.created_at),
  };
}

export function ensureRoutingTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_route_logs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      project_id TEXT,
      user_input_preview TEXT NOT NULL,
      task_type TEXT NOT NULL,
      selected_level INTEGER NOT NULL,
      execution_strategy TEXT NOT NULL,
      selected_model_id TEXT,
      draft_model_id TEXT,
      review_model_id TEXT,
      final_model_id TEXT,
      risk TEXT NOT NULL,
      reason TEXT NOT NULL,
      source TEXT NOT NULL,
      candidates_json TEXT NOT NULL,
      require_user_confirmation INTEGER NOT NULL DEFAULT 0,
      fallback_note TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_route_logs_session ON model_route_logs(session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS model_call_logs (
      id TEXT PRIMARY KEY,
      route_log_id TEXT,
      collaboration_run_id TEXT,
      session_id TEXT,
      model_id TEXT NOT NULL,
      role TEXT NOT NULL,
      input_preview TEXT,
      output_preview TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      duration_ms INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_call_logs_route ON model_call_logs(route_log_id, created_at);

    CREATE TABLE IF NOT EXISTS model_collaboration_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      project_id TEXT,
      route_log_id TEXT,
      strategy TEXT NOT NULL,
      draft_model_id TEXT,
      review_model_id TEXT,
      final_model_id TEXT,
      verdict TEXT,
      confidence REAL,
      issues_json TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}
