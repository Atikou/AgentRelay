import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type { PermissionConfirmationRequest } from "./PermissionGuard.js";
import {
  PERMISSION_REQUEST_SCHEMA_VERSION,
  toScopedApprovedPermissions,
  type PermissionRequestDecision,
  type PermissionRequestItem,
  type PermissionRequestPayload,
  type PermissionRequestRespondInput,
  type ScopedApprovedPermissions,
} from "./permissionRequestTypes.js";

export interface CreatePermissionRequestInput {
  runId: string;
  sessionId?: string;
  title: string;
  summary: string;
  requiredPermissions: PermissionRequestItem[];
  planMarkdown?: string;
  intent?: string;
  executionStage?: string;
  planVariant?: PermissionRequestPayload["planVariant"];
  blockedTool?: PermissionRequestPayload["blockedTool"];
}

export class PermissionRequestStore {
  private readonly requests = new Map<string, PermissionRequestPayload>();
  private readonly byRunId = new Map<string, string>();

  constructor(private readonly db?: DatabaseSync) {}

  create(input: CreatePermissionRequestInput): PermissionRequestPayload {
    if (this.db) {
      const existing = this.getPendingByRunId(input.runId);
      if (existing) return existing;

      const payload = this.buildPayload(input);
      this.db
        .prepare(
          `INSERT INTO permission_requests
           (id, run_id, session_id, status, payload_json, created_at, updated_at, responded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          payload.id,
          payload.runId,
          payload.sessionId ?? null,
          payload.status,
          JSON.stringify(payload),
          payload.createdAt,
          payload.createdAt,
          null,
        );
      return payload;
    }

    const existingId = this.byRunId.get(input.runId);
    if (existingId) {
      const existing = this.requests.get(existingId);
      if (existing?.status === "pending") return existing;
    }

    const payload = this.buildPayload(input);
    this.requests.set(payload.id, payload);
    this.byRunId.set(input.runId, payload.id);
    return payload;
  }

  private buildPayload(input: CreatePermissionRequestInput): PermissionRequestPayload {
    const payload: PermissionRequestPayload = {
      schemaVersion: PERMISSION_REQUEST_SCHEMA_VERSION,
      id: randomUUID(),
      runId: input.runId,
      sessionId: input.sessionId,
      status: "pending",
      title: input.title,
      summary: input.summary,
      planMarkdown: input.planMarkdown,
      intent: input.intent,
      executionStage: input.executionStage,
      planVariant: input.planVariant,
      requiredPermissions: input.requiredPermissions,
      blockedTool: input.blockedTool,
      createdAt: new Date().toISOString(),
    };
    return payload;
  }

  get(id: string): PermissionRequestPayload | null {
    if (this.db) {
      const row = this.db
        .prepare(`SELECT payload_json FROM permission_requests WHERE id=?`)
        .get(id) as { payload_json: string } | undefined;
      return this.parsePayload(row);
    }
    return this.requests.get(id) ?? null;
  }

  getPendingByRunId(runId: string): PermissionRequestPayload | null {
    if (this.db) {
      const row = this.db
        .prepare(
          `SELECT payload_json FROM permission_requests
           WHERE run_id=? AND status='pending'
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(runId) as { payload_json: string } | undefined;
      return this.parsePayload(row);
    }

    const id = this.byRunId.get(runId);
    if (!id) return null;
    const request = this.requests.get(id);
    if (!request || request.status !== "pending") return null;
    return request;
  }

  getApprovedByRunId(runId: string): PermissionRequestPayload | null {
    if (this.db) {
      const row = this.db
        .prepare(
          `SELECT payload_json FROM permission_requests
           WHERE run_id=? AND status='approved'
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(runId) as { payload_json: string } | undefined;
      return this.parsePayload(row);
    }
    for (const request of this.requests.values()) {
      if (request.runId === runId && request.status === "approved") return request;
    }
    return null;
  }

  listPending(opts?: { sessionId?: string; runId?: string }): PermissionRequestPayload[] {
    if (this.db) {
      const where: string[] = ["status='pending'"];
      const args: SQLInputValue[] = [];
      if (opts?.runId) {
        where.push("run_id=?");
        args.push(opts.runId);
      }
      if (opts?.sessionId) {
        where.push("session_id=?");
        args.push(opts.sessionId);
      }
      const rows = this.db
        .prepare(
          `SELECT payload_json FROM permission_requests
           WHERE ${where.join(" AND ")}
           ORDER BY updated_at DESC`,
        )
        .all(...args) as Array<{ payload_json: string }>;
      return rows
        .map((row) => this.parsePayload(row))
        .filter((item): item is PermissionRequestPayload => Boolean(item));
    }

    const all = [...this.requests.values()].filter((item) => item.status === "pending");
    if (opts?.runId) return all.filter((item) => item.runId === opts.runId);
    if (opts?.sessionId) return all.filter((item) => item.sessionId === opts.sessionId);
    return all;
  }

  respond(id: string, input: PermissionRequestRespondInput): PermissionRequestPayload | null {
    const existing = this.get(id);
    if (!existing || existing.status !== "pending") return null;

    const respondedAt = new Date().toISOString();
    if (input.decision === "deny") {
      const denied: PermissionRequestPayload = {
        ...existing,
        status: "denied",
        respondedAt,
        decision: input.decision,
      };
      this.persistResponse(denied, respondedAt);
      return denied;
    }

    const approvedItems =
      input.approvedPermissions && input.approvedPermissions.length > 0
        ? input.approvedPermissions
        : existing.requiredPermissions;
    const approved: PermissionRequestPayload = {
      ...existing,
      status: "approved",
      respondedAt,
      decision: input.decision,
      approvedPermissions: toScopedApprovedPermissions(approvedItems),
    };
    this.persistResponse(approved, respondedAt);
    return approved;
  }

  private persistResponse(payload: PermissionRequestPayload, respondedAt: string): void {
    if (!this.db) {
      this.requests.set(payload.id, payload);
      return;
    }
    this.db
      .prepare(
        `UPDATE permission_requests
         SET status=?, payload_json=?, updated_at=?, responded_at=?
         WHERE id=?`,
      )
      .run(payload.status, JSON.stringify(payload), respondedAt, respondedAt, payload.id);
  }

  private parsePayload(row: { payload_json: string } | undefined): PermissionRequestPayload | null {
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.payload_json) as PermissionRequestPayload;
      if (!parsed || typeof parsed !== "object" || typeof parsed.id !== "string") return null;
      return parsed;
    } catch {
      return null;
    }
  }
}

export const defaultPermissionRequestStore = new PermissionRequestStore();

export function permissionItemsFromConfirmation(
  confirmation: PermissionConfirmationRequest,
): PermissionRequestItem[] {
  const items: PermissionRequestItem[] = [];
  for (const file of confirmation.affects.files) {
      items.push({
        type: confirmation.permission === "read" ? "read_file" : "write_file",
        target: file,
        reason: confirmation.message,
        tool: confirmation.tool,
        riskTier: confirmation.risk.tier,
        rootPath: file.replace(/[\\/]\*\*?$/, ""),
        operation: confirmation.permission === "read" ? "read" : "write",
        pathRisk: confirmation.risk.reasons.find((r) => r !== "cross_workspace"),
      });
  }
  for (const command of confirmation.affects.commands) {
      items.push({
        type: "shell",
        target: command,
        reason: confirmation.message,
        tool: confirmation.tool,
        riskTier: confirmation.risk.tier,
        rootPath: command.replace(/[\\/]\*\*?$/, ""),
        operation: "shell",
        pathRisk: confirmation.risk.reasons.find((r) => r !== "cross_workspace"),
      });
  }
  for (const target of confirmation.affects.networkTargets) {
    items.push({
      type: "network",
      target,
      reason: confirmation.message,
      tool: confirmation.tool,
      riskTier: confirmation.risk.tier,
    });
  }
  if (items.length === 0) {
    items.push({
      type:
        confirmation.permission === "read"
          ? "read_file"
          : confirmation.permission === "shell"
            ? "shell"
            : "write_file",
      target: confirmation.action,
      reason: confirmation.message,
      tool: confirmation.tool,
      riskTier: confirmation.risk.tier,
      rootPath: confirmation.action.replace(/[\\/]\*\*?$/, ""),
      operation:
        confirmation.permission === "read"
          ? "read"
          : confirmation.permission === "shell"
            ? "shell"
            : "write",
      pathRisk: confirmation.risk.reasons.find((r) => r !== "cross_workspace"),
    });
  }
  return items;
}

export function applyDecisionToSessionGrants(
  sessionGrants: { merge(sessionId: string, patch: ScopedApprovedPermissions): ScopedApprovedPermissions },
  sessionId: string | undefined,
  decision: PermissionRequestDecision,
  approved?: ScopedApprovedPermissions,
): ScopedApprovedPermissions | undefined {
  if (!sessionId || !approved) return undefined;
  if (decision === "allow_session") {
    return sessionGrants.merge(sessionId, approved);
  }
  return approved;
}
