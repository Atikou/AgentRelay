import path from "node:path";

import type { AppContext } from "../../app/createAppContext.js";
import type { ApiResult } from "../../orchestrator/Orchestrator.js";
import {
  WorkspaceScopeManager,
  type WorkspaceGrantScope,
  type WorkspaceScopePermission,
} from "../../policy/WorkspaceScopeManager.js";

export function handleWorkspaceScopesList(app: AppContext, url: URL): ApiResult {
  const sessionId = url.searchParams.get("sessionId") ?? undefined;
  const workspaceRoot = app.resolveWorkspaceRootForSession(sessionId);
  const manager = new WorkspaceScopeManager({
    primaryRoot: workspaceRoot,
    primaryLabel: "当前会话工作区",
    grants: app.workspaceGrantStore,
    configScopes: app.workspaceConfigScopesForSession(sessionId),
  });
  const scopes = manager.getScopes({
    sessionId,
    scopedGrants: app.sessionPermissionGrants.get(sessionId),
  });
  return {
    status: 200,
    body: {
      sessionId,
      primaryRoot: workspaceRoot,
      scopes,
    },
  };
}

export function handleWorkspaceScopeCreate(app: AppContext, body: unknown): ApiResult {
  const payload = (body ?? {}) as Record<string, unknown>;
  const rootPath = typeof payload.rootPath === "string" ? payload.rootPath.trim() : "";
  if (!rootPath) return { status: 400, body: { error: "rootPath 不能为空" } };
  const permissions = parsePermissions(payload.permissions);
  if (permissions.length === 0) return { status: 400, body: { error: "permissions 至少包含 read/write/shell" } };
  const scope = parseGrantScope(payload.scope) ?? "session";
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
  const projectId = typeof payload.projectId === "string" ? payload.projectId : undefined;
  const expiresAt = typeof payload.expiresAt === "string" ? payload.expiresAt : undefined;
  const grant = app.workspaceGrantStore.add({
    sessionId,
    projectId,
    rootPath: path.resolve(rootPath),
    permissions,
    scope,
    expiresAt,
    source: "user_confirmed",
  });
  return { status: 200, body: { grant } };
}

export function handleWorkspaceScopeUpdate(app: AppContext, id: string, body: unknown): ApiResult {
  const payload = (body ?? {}) as Record<string, unknown>;
  const permissions = Array.isArray(payload.permissions) ? parsePermissions(payload.permissions) : undefined;
  const scope = parseGrantScope(payload.scope);
  const expiresAt = typeof payload.expiresAt === "string" ? payload.expiresAt : undefined;
  const grant = app.workspaceGrantStore.update(id.trim(), {
    permissions,
    scope,
    expiresAt,
  });
  if (!grant) return { status: 404, body: { error: "授权不存在或已撤销", id } };
  return { status: 200, body: { grant } };
}

export function handleWorkspaceScopeDelete(app: AppContext, id: string, body?: unknown): ApiResult {
  const payload = (body ?? {}) as Record<string, unknown>;
  const reason = typeof payload.reason === "string" ? payload.reason : "user_revoked";
  const revoked = app.workspaceGrantStore.revoke(id.trim(), reason);
  if (!revoked) return { status: 404, body: { error: "授权不存在或已撤销", id } };
  return { status: 200, body: { id, revoked: true } };
}

export function handleWorkspaceScopeAudit(app: AppContext, url: URL): ApiResult {
  const sessionId = url.searchParams.get("sessionId") ?? undefined;
  const runId = url.searchParams.get("runId") ?? undefined;
  const limitRaw = Number(url.searchParams.get("limit") ?? 100);
  const audit = app.workspaceGrantStore.listAudit({
    sessionId,
    runId,
    limit: Number.isFinite(limitRaw) ? limitRaw : 100,
  });
  return { status: 200, body: { audit, count: audit.length } };
}

function parsePermissions(value: unknown): WorkspaceScopePermission[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value)].filter((p): p is WorkspaceScopePermission => p === "read" || p === "write" || p === "shell");
}

function parseGrantScope(value: unknown): WorkspaceGrantScope | undefined {
  return value === "once" || value === "session" || value === "project" || value === "workspace" ? value : undefined;
}
