import { randomUUID } from "node:crypto";

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

  create(input: CreatePermissionRequestInput): PermissionRequestPayload {
    const existingId = this.byRunId.get(input.runId);
    if (existingId) {
      const existing = this.requests.get(existingId);
      if (existing?.status === "pending") return existing;
    }

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
    this.requests.set(payload.id, payload);
    this.byRunId.set(input.runId, payload.id);
    return payload;
  }

  get(id: string): PermissionRequestPayload | null {
    return this.requests.get(id) ?? null;
  }

  getPendingByRunId(runId: string): PermissionRequestPayload | null {
    const id = this.byRunId.get(runId);
    if (!id) return null;
    const request = this.requests.get(id);
    if (!request || request.status !== "pending") return null;
    return request;
  }

  listPending(opts?: { sessionId?: string; runId?: string }): PermissionRequestPayload[] {
    const all = [...this.requests.values()].filter((item) => item.status === "pending");
    if (opts?.runId) return all.filter((item) => item.runId === opts.runId);
    if (opts?.sessionId) return all.filter((item) => item.sessionId === opts.sessionId);
    return all;
  }

  respond(id: string, input: PermissionRequestRespondInput): PermissionRequestPayload | null {
    const existing = this.requests.get(id);
    if (!existing || existing.status !== "pending") return null;

    const respondedAt = new Date().toISOString();
    if (input.decision === "deny") {
      const denied: PermissionRequestPayload = {
        ...existing,
        status: "denied",
        respondedAt,
        decision: input.decision,
      };
      this.requests.set(id, denied);
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
    this.requests.set(id, approved);
    return approved;
  }
}

export const defaultPermissionRequestStore = new PermissionRequestStore();

export function permissionItemsFromConfirmation(
  confirmation: PermissionConfirmationRequest,
): PermissionRequestItem[] {
  const items: PermissionRequestItem[] = [];
  for (const file of confirmation.affects.files) {
    items.push({
      type: "write_file",
      target: file,
      reason: confirmation.message,
      tool: confirmation.tool,
      riskTier: confirmation.risk.tier,
    });
  }
  for (const command of confirmation.affects.commands) {
    items.push({
      type: "shell",
      target: command,
      reason: confirmation.message,
      tool: confirmation.tool,
      riskTier: confirmation.risk.tier,
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
      type: confirmation.permission === "shell" ? "shell" : "write_file",
      target: confirmation.action,
      reason: confirmation.message,
      tool: confirmation.tool,
      riskTier: confirmation.risk.tier,
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
