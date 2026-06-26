/** 固定 JSON 权限申请协议（schemaVersion=1）。 */
export const PERMISSION_REQUEST_SCHEMA_VERSION = 1 as const;

export type PermissionRequestItemType = "read_file" | "write_file" | "shell" | "delete_file" | "network" | "dangerous";

export type PermissionRequestStatus = "pending" | "approved" | "denied" | "expired";

export type PermissionRequestDecision = "allow_once" | "allow_session" | "allow_project" | "allow_workspace" | "deny";

export interface PermissionRequestItem {
  type: PermissionRequestItemType;
  target: string;
  reason: string;
  tool?: string;
  riskTier?: "low" | "medium" | "high" | "critical";
  workspaceScope?: string;
  grantScope?: "once" | "session" | "project" | "workspace";
  rootPath?: string;
  operation?: "read" | "write" | "shell";
  pathRisk?: string;
  diffPreview?: string;
  inputPreview?: string;
  auditId?: string;
}

export interface ScopedApprovedPermissions {
  read_file?: string[];
  write_file?: string[];
  shell?: string[];
  delete_file?: string[];
  network?: string[];
  dangerous?: string[];
}

export interface PermissionRequestPayload {
  schemaVersion: typeof PERMISSION_REQUEST_SCHEMA_VERSION;
  id: string;
  runId: string;
  sessionId?: string;
  status: PermissionRequestStatus;
  title: string;
  summary: string;
  planMarkdown?: string;
  intent?: string;
  executionStage?: string;
  planVariant?: "plan_only" | "plan_wait_approval" | "plan_then_execute";
  requiredPermissions: PermissionRequestItem[];
  blockedTool?: {
    name: string;
    input?: Record<string, unknown>;
  };
  createdAt: string;
  respondedAt?: string;
  decision?: PermissionRequestDecision;
  approvedPermissions?: ScopedApprovedPermissions;
}

export interface PermissionRequestRespondInput {
  decision: PermissionRequestDecision;
  approvedPermissions?: PermissionRequestItem[];
}

export function toScopedApprovedPermissions(
  items: PermissionRequestItem[] | undefined,
): ScopedApprovedPermissions {
  const scoped: ScopedApprovedPermissions = {};
  for (const item of items ?? []) {
    const bucket = item.type;
    if (!scoped[bucket]) scoped[bucket] = [];
    scoped[bucket]!.push(item.target);
  }
  return scoped;
}

export function normalizePermissionTarget(target: string): string {
  return target.replace(/\\/g, "/").trim();
}
