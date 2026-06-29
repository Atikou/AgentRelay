import type { AppContext } from "../../app/createAppContext.js";
import type { ApiResult } from "../../orchestrator/Orchestrator.js";
import {
  applyDecisionToSessionGrants,
  defaultPermissionRequestStore,
} from "../../policy/PermissionRequestStore.js";
import { defaultSessionPermissionGrants } from "../../policy/SessionPermissionGrants.js";
import type {
  PermissionRequestDecision,
  PermissionRequestItem,
} from "../../policy/permissionRequestTypes.js";

function parseDecision(value: unknown): PermissionRequestDecision | undefined {
  if (
    value === "allow_once" ||
    value === "allow_session" ||
    value === "allow_project" ||
    value === "allow_workspace" ||
    value === "deny"
  ) {
    return value;
  }
  return undefined;
}

function parseApprovedItems(value: unknown): PermissionRequestItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: PermissionRequestItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const type = record.type;
    const target = record.target;
    const reason = record.reason;
    if (
      (type === "read_file" ||
        type === "write_file" ||
        type === "shell" ||
        type === "delete_file" ||
        type === "network" ||
        type === "dangerous") &&
      typeof target === "string" &&
      typeof reason === "string"
    ) {
      items.push({
        type,
        target,
        reason,
        tool: typeof record.tool === "string" ? record.tool : undefined,
        riskTier:
          record.riskTier === "low" ||
          record.riskTier === "medium" ||
          record.riskTier === "high" ||
          record.riskTier === "critical"
            ? record.riskTier
            : undefined,
        workspaceScope: typeof record.workspaceScope === "string" ? record.workspaceScope : undefined,
        grantScope:
          record.grantScope === "once" ||
          record.grantScope === "session" ||
          record.grantScope === "project" ||
          record.grantScope === "workspace"
            ? record.grantScope
            : undefined,
        rootPath: typeof record.rootPath === "string" ? record.rootPath : undefined,
        operation:
          record.operation === "read" || record.operation === "write" || record.operation === "shell"
            ? record.operation
            : undefined,
        pathRisk: typeof record.pathRisk === "string" ? record.pathRisk : undefined,
        diffPreview: typeof record.diffPreview === "string" ? record.diffPreview : undefined,
        inputPreview: typeof record.inputPreview === "string" ? record.inputPreview : undefined,
        auditId: typeof record.auditId === "string" ? record.auditId : undefined,
      });
    }
  }
  return items.length ? items : undefined;
}

export function handlePermissionRequestGet(app: AppContext, id: string): ApiResult {
  const request = app.permissionRequestStore.get(id.trim());
  if (!request) return { status: 404, body: { error: "权限申请不存在", id } };
  return { status: 200, body: { permissionRequest: request } };
}

export function handlePermissionRequestsPending(app: AppContext, url: URL): ApiResult {
  const sessionId = url.searchParams.get("sessionId") ?? undefined;
  const runId = url.searchParams.get("runId") ?? undefined;
  const pending = app.permissionRequestStore.listPending({ sessionId, runId });
  return { status: 200, body: { permissionRequests: pending, count: pending.length } };
}

export function handlePermissionRequestRespond(
  app: AppContext,
  id: string,
  body: unknown,
): ApiResult {
  const payload = (body ?? {}) as {
    decision?: unknown;
    approvedPermissions?: unknown;
  };
  const decision = parseDecision(payload.decision);
  if (!decision) {
    return {
      status: 400,
      body: { error: "decision 必须是 allow_once / allow_session / allow_project / allow_workspace / deny" },
    };
  }

  const existing = app.permissionRequestStore.get(id.trim());
  if (!existing) {
    return { status: 404, body: { error: "权限申请不存在或已处理", id } };
  }
  if (
    decision === "allow_workspace" &&
    existing.requiredPermissions.some((item) => item.type === "shell")
  ) {
    return {
      status: 400,
      body: { error: "shell 权限不支持长期工作区授权，请使用允许一次或本次会话" },
    };
  }

  const responded = app.permissionRequestStore.respond(id.trim(), {
    decision,
    approvedPermissions: parseApprovedItems(payload.approvedPermissions),
  });
  if (!responded) {
    return { status: 404, body: { error: "权限申请不存在或已处理", id } };
  }

  const sessionGrants = applyDecisionToSessionGrants(
    app.sessionPermissionGrants,
    responded.sessionId,
    decision === "allow_session" ? decision : decision === "allow_once" ? decision : "allow_once",
    responded.approvedPermissions,
  );

  if (decision === "allow_project" || decision === "allow_workspace") {
    for (const item of responded.requiredPermissions) {
      const operation =
        item.operation ?? (item.type === "shell" ? "shell" : item.type === "write_file" ? "write" : "read");
      const rootPath = item.rootPath ?? item.target.replace(/[\\/]\*\*?$/, "");
      app.workspaceGrantStore.add({
        sessionId: decision === "allow_project" ? responded.sessionId : undefined,
        rootPath,
        permissions: [operation],
        scope: decision === "allow_project" ? "project" : "workspace",
        source: "user_confirmed",
      });
    }
  }

  if (decision !== "deny") {
    app.runs.update(responded.runId, { status: "waiting_confirmation" });
  } else {
    app.runs.update(responded.runId, { status: "cancelled" });
    app.pausedRunStore?.delete(responded.runId);
  }

  return {
    status: 200,
    body: {
      permissionRequest: responded,
      sessionGrants: sessionGrants ?? undefined,
      runId: responded.runId,
      status: decision === "deny" ? "cancelled" : "approved",
    },
  };
}

export function handleRunApprove(app: AppContext, runId: string, body: unknown): ApiResult {
  const pending = app.permissionRequestStore.getPendingByRunId(runId.trim());
  if (!pending) {
    return { status: 404, body: { error: "该 Run 没有待处理的权限申请", runId } };
  }
  return handlePermissionRequestRespond(app, pending.id, body);
}

export { defaultPermissionRequestStore, defaultSessionPermissionGrants };
