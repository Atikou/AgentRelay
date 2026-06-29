import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type { ScopedApprovedPermissions } from "./permissionRequestTypes.js";

export type WorkspaceScopePermission = "read" | "write" | "shell";
export type WorkspaceScopeKind = "primary" | "granted" | "config" | "temporary";
export type WorkspaceGrantScope = "once" | "session" | "project" | "workspace";
export type WorkspaceGrantSource = "user_confirmed" | "config";

export interface WorkspaceScope {
  id: string;
  rootPath: string;
  label?: string;
  kind: WorkspaceScopeKind;
  permissions: WorkspaceScopePermission[];
  grantScope: WorkspaceGrantScope;
  expiresAt?: string;
  grantId?: string;
  source: "primary" | WorkspaceGrantSource;
  grantVersion?: string;
}

export interface WorkspaceGrant {
  id: string;
  sessionId?: string;
  projectId?: string;
  taskId?: string;
  rootPath: string;
  permissions: WorkspaceScopePermission[];
  scope: WorkspaceGrantScope;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  revokedAt?: string;
  revokedReason?: string;
  source: WorkspaceGrantSource;
}

export interface WorkspaceGrantInput {
  id?: string;
  sessionId?: string;
  projectId?: string;
  taskId?: string;
  rootPath: string;
  permissions: WorkspaceScopePermission[];
  scope: WorkspaceGrantScope;
  expiresAt?: string;
  source?: WorkspaceGrantSource;
}

export interface WorkspaceGrantFilter {
  sessionId?: string;
  projectId?: string;
  includeExpired?: boolean;
  includeRevoked?: boolean;
}

export interface WorkspaceAccessAuditInput {
  runId?: string;
  sessionId?: string;
  taskId?: string;
  toolCallId?: string;
  toolName: string;
  operation: WorkspaceScopePermission;
  normalizedPath: string;
  matchedRoot?: string;
  workspaceScopeId?: string;
  grantId?: string;
  permissionSource?: string;
  decision: "allowed" | "needs_confirmation" | "denied";
  reason: string;
  crossWorkspace: boolean;
  pathRisk: string;
  pathRiskTier: string;
}

export interface WorkspaceAccessAuditRecord extends WorkspaceAccessAuditInput {
  id: string;
  createdAt: string;
}

export class WorkspaceGrantStore {
  private readonly grants = new Map<string, WorkspaceGrant>();
  private readonly audit = new Map<string, WorkspaceAccessAuditRecord>();

  constructor(private readonly db?: DatabaseSync) {}

  list(filter: WorkspaceGrantFilter = {}): WorkspaceGrant[] {
    const now = Date.now();
    const active = (grant: WorkspaceGrant) => {
      if (!filter.includeRevoked && grant.revokedAt) return false;
      if (!filter.includeExpired && grant.expiresAt && Date.parse(grant.expiresAt) <= now) return false;
      if (grant.scope === "session" || grant.scope === "once") {
        if (filter.sessionId && grant.sessionId && grant.sessionId !== filter.sessionId) return false;
        if (filter.sessionId && !grant.sessionId) return false;
      }
      if (grant.scope === "project" && filter.projectId && grant.projectId && grant.projectId !== filter.projectId) {
        return false;
      }
      return true;
    };

    if (!this.db) return [...this.grants.values()].filter(active);

    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (!filter.includeRevoked) where.push("revoked_at IS NULL");
    if (!filter.includeExpired) where.push("(expires_at IS NULL OR expires_at > ?)");
    if (!filter.includeExpired) args.push(new Date().toISOString());
    if (filter.sessionId) {
      where.push("(session_id IS NULL OR session_id = ? OR scope IN ('project','workspace'))");
      args.push(filter.sessionId);
    }
    if (filter.projectId) {
      where.push("(project_id IS NULL OR project_id = ? OR scope != 'project')");
      args.push(filter.projectId);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM workspace_grants
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY updated_at DESC`,
      )
      .all(...args) as unknown as WorkspaceGrantRow[];
    return rows.map(rowToGrant).filter(active);
  }

  add(input: WorkspaceGrantInput): WorkspaceGrant {
    const now = new Date().toISOString();
    const grant: WorkspaceGrant = {
      id: input.id ?? randomUUID(),
      sessionId: input.sessionId,
      projectId: input.projectId,
      taskId: input.taskId,
      rootPath: canonicalizeExistingPath(input.rootPath),
      permissions: normalizePermissions(input.permissions),
      scope: input.scope,
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt,
      source: input.source ?? "user_confirmed",
    };
    this.grants.set(grant.id, grant);
    if (this.db && grant.scope !== "once") {
      this.db
        .prepare(
          `INSERT INTO workspace_grants
           (id, session_id, project_id, task_id, root_path, permissions_json, scope, source,
            created_at, updated_at, expires_at, revoked_at, revoked_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             session_id=excluded.session_id,
             project_id=excluded.project_id,
             task_id=excluded.task_id,
             root_path=excluded.root_path,
             permissions_json=excluded.permissions_json,
             scope=excluded.scope,
             source=excluded.source,
             updated_at=excluded.updated_at,
             expires_at=excluded.expires_at,
             revoked_at=NULL,
             revoked_reason=NULL`,
        )
        .run(
          grant.id,
          grant.sessionId ?? null,
          grant.projectId ?? null,
          grant.taskId ?? null,
          grant.rootPath,
          JSON.stringify(grant.permissions),
          grant.scope,
          grant.source,
          grant.createdAt,
          grant.updatedAt,
          grant.expiresAt ?? null,
          null,
          null,
        );
    }
    return grant;
  }

  update(id: string, patch: Partial<Pick<WorkspaceGrant, "permissions" | "expiresAt" | "scope">>): WorkspaceGrant | null {
    const existing = this.get(id);
    if (!existing || existing.revokedAt) return null;
    const updated: WorkspaceGrant = {
      ...existing,
      permissions: patch.permissions ? normalizePermissions(patch.permissions) : existing.permissions,
      expiresAt: patch.expiresAt ?? existing.expiresAt,
      scope: patch.scope ?? existing.scope,
      updatedAt: new Date().toISOString(),
    };
    this.grants.set(id, updated);
    if (this.db && updated.scope !== "once") {
      this.db
        .prepare(
          `UPDATE workspace_grants
           SET permissions_json=?, scope=?, expires_at=?, updated_at=?
           WHERE id=? AND revoked_at IS NULL`,
        )
        .run(JSON.stringify(updated.permissions), updated.scope, updated.expiresAt ?? null, updated.updatedAt, id);
    }
    return updated;
  }

  revoke(id: string, reason = "user_revoked"): boolean {
    const existing = this.get(id);
    if (!existing || existing.revokedAt) return false;
    const revokedAt = new Date().toISOString();
    this.grants.set(id, { ...existing, revokedAt, revokedReason: reason, updatedAt: revokedAt });
    if (this.db) {
      this.db
        .prepare(`UPDATE workspace_grants SET revoked_at=?, revoked_reason=?, updated_at=? WHERE id=?`)
        .run(revokedAt, reason, revokedAt, id);
    }
    return true;
  }

  get(id: string): WorkspaceGrant | null {
    const memory = this.grants.get(id);
    if (memory) return memory;
    if (!this.db) return null;
    const row = this.db.prepare(`SELECT * FROM workspace_grants WHERE id=?`).get(id) as WorkspaceGrantRow | undefined;
    return row ? rowToGrant(row) : null;
  }

  recordAccess(input: WorkspaceAccessAuditInput): WorkspaceAccessAuditRecord {
    const record: WorkspaceAccessAuditRecord = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.audit.set(record.id, record);
    if (this.db) {
      this.db
        .prepare(
          `INSERT INTO workspace_access_audit
           (id, run_id, session_id, task_id, tool_call_id, tool_name, operation, normalized_path,
            matched_root, workspace_scope_id, grant_id, permission_source, decision, reason,
            cross_workspace, path_risk, path_risk_tier, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.runId ?? null,
          record.sessionId ?? null,
          record.taskId ?? null,
          record.toolCallId ?? null,
          record.toolName,
          record.operation,
          record.normalizedPath,
          record.matchedRoot ?? null,
          record.workspaceScopeId ?? null,
          record.grantId ?? null,
          record.permissionSource ?? null,
          record.decision,
          record.reason,
          record.crossWorkspace ? 1 : 0,
          record.pathRisk,
          record.pathRiskTier,
          record.createdAt,
        );
    }
    return record;
  }

  listAudit(filter: { sessionId?: string; runId?: string; limit?: number } = {}): WorkspaceAccessAuditRecord[] {
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500));
    if (!this.db) {
      return [...this.audit.values()]
        .filter((r) => !filter.sessionId || r.sessionId === filter.sessionId)
        .filter((r) => !filter.runId || r.runId === filter.runId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    }
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.sessionId) {
      where.push("session_id=?");
      args.push(filter.sessionId);
    }
    if (filter.runId) {
      where.push("run_id=?");
      args.push(filter.runId);
    }
    args.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM workspace_access_audit
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...args) as unknown as WorkspaceAuditRow[];
    return rows.map(rowToAudit);
  }
}

export interface WorkspaceScopeManagerOptions {
  primaryRoot: string;
  primaryLabel?: string;
  grants?: WorkspaceGrantStore;
  configScopes?: Array<{
    id: string;
    rootPath: string;
    label?: string;
    permissions?: WorkspaceScopePermission[];
  }>;
}

export class WorkspaceScopeManager {
  private readonly primaryRoot: string;
  private readonly grants: WorkspaceGrantStore;
  private readonly configScopes: WorkspaceScope[];

  constructor(private readonly options: WorkspaceScopeManagerOptions) {
    this.primaryRoot = canonicalizeExistingPath(options.primaryRoot);
    this.grants = options.grants ?? new WorkspaceGrantStore();
    this.configScopes = (options.configScopes ?? []).map((scope) => ({
      id: scope.id,
      rootPath: canonicalizeExistingPath(scope.rootPath),
      label: scope.label,
      kind: "config",
      permissions: scope.permissions ?? ["read"],
      grantScope: "project",
      source: "config",
      grantVersion: "config",
    }));
  }

  getScopes(input?: {
    sessionId?: string;
    projectId?: string;
    scopedGrants?: ScopedApprovedPermissions;
  }): WorkspaceScope[] {
    const primary: WorkspaceScope = {
      id: "primary",
      rootPath: this.primaryRoot,
      label: this.options.primaryLabel ?? "Primary workspace",
      kind: "primary",
      permissions: ["read", "write", "shell"],
      grantScope: "workspace",
      source: "primary",
      grantVersion: "primary",
    };
    const persisted = this.grants.list({ sessionId: input?.sessionId, projectId: input?.projectId }).map(grantToScope);
    const scoped = scopesFromApprovedPermissions(input?.scopedGrants);
    return dedupeScopes([primary, ...this.configScopes, ...persisted, ...scoped]);
  }

  addScope(grant: WorkspaceGrantInput): WorkspaceGrant {
    return this.grants.add(grant);
  }

  revokeScope(scopeId: string): boolean {
    return this.grants.revoke(scopeId);
  }

  resolveScopeForPath(
    targetPath: string,
    operation: WorkspaceScopePermission,
    input?: { sessionId?: string; projectId?: string; scopedGrants?: ScopedApprovedPermissions },
  ): WorkspaceScope | null {
    const full = canonicalizeExistingPath(targetPath);
    const matches = this.getScopes(input)
      .filter((scope) => scope.permissions.includes(operation))
      .filter((scope) => isInsideScope(scope.rootPath, full))
      .sort((a, b) => b.rootPath.length - a.rootPath.length);
    return matches[0] ?? null;
  }
}

export function isInsideScope(rootPath: string, targetPath: string): boolean {
  const root = canonicalizeExistingPath(rootPath);
  const full = canonicalizeExistingPath(targetPath);
  const rel = path.relative(root, full);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function canonicalizeExistingPath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function grantToScope(grant: WorkspaceGrant): WorkspaceScope {
  return {
    id: grant.id,
    rootPath: grant.rootPath,
    kind: "granted",
    permissions: grant.permissions,
    grantScope: grant.scope,
    expiresAt: grant.expiresAt,
    grantId: grant.id,
    source: grant.source,
    grantVersion: grant.updatedAt,
  };
}

function scopesFromApprovedPermissions(grants?: ScopedApprovedPermissions): WorkspaceScope[] {
  if (!grants) return [];
  const scopes: WorkspaceScope[] = [];
  const add = (bucket: keyof ScopedApprovedPermissions, permission: WorkspaceScopePermission) => {
    for (const target of grants[bucket] ?? []) {
      const rootPath = normalizeGrantTargetToRoot(target);
      if (!rootPath) continue;
      scopes.push({
        id: `scoped:${bucket}:${rootPath}`,
        rootPath,
        kind: "temporary",
        permissions: [permission],
        grantScope: "once",
        source: "user_confirmed",
        grantId: `scoped:${bucket}:${rootPath}`,
        grantVersion: "once",
      });
    }
  };
  add("read_file", "read");
  add("write_file", "write");
  add("shell", "shell");
  return scopes;
}

export function normalizeGrantTargetToRoot(target: string): string | undefined {
  const trimmed = target.trim();
  if (!trimmed) return undefined;
  const withoutGlob = trimmed.replace(/[\\/]\*\*?$/, "");
  return canonicalizeExistingPath(withoutGlob);
}

function dedupeScopes(scopes: WorkspaceScope[]): WorkspaceScope[] {
  const byKey = new Map<string, WorkspaceScope>();
  for (const scope of scopes) {
    const rootPath = canonicalizeExistingPath(scope.rootPath);
    const key = `${rootPath.toLowerCase()}::${scope.kind}::${scope.source}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...scope, rootPath });
      continue;
    }
    existing.permissions = [...new Set([...existing.permissions, ...scope.permissions])];
    existing.grantVersion = [existing.grantVersion, scope.grantVersion].filter(Boolean).join("|");
  }
  return [...byKey.values()];
}

function normalizePermissions(permissions: WorkspaceScopePermission[]): WorkspaceScopePermission[] {
  return [...new Set(permissions)].filter((p): p is WorkspaceScopePermission =>
    p === "read" || p === "write" || p === "shell",
  );
}

interface WorkspaceGrantRow {
  id: string;
  session_id: string | null;
  project_id: string | null;
  task_id: string | null;
  root_path: string;
  permissions_json: string;
  scope: string;
  source: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

function rowToGrant(row: WorkspaceGrantRow): WorkspaceGrant {
  let permissions: WorkspaceScopePermission[] = ["read"];
  try {
    permissions = normalizePermissions(JSON.parse(row.permissions_json) as WorkspaceScopePermission[]);
  } catch {
    permissions = ["read"];
  }
  return {
    id: row.id,
    sessionId: row.session_id ?? undefined,
    projectId: row.project_id ?? undefined,
    taskId: row.task_id ?? undefined,
    rootPath: canonicalizeExistingPath(row.root_path),
    permissions,
    scope: isGrantScope(row.scope) ? row.scope : "session",
    source: row.source === "config" ? "config" : "user_confirmed",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    revokedReason: row.revoked_reason ?? undefined,
  };
}

function isGrantScope(value: string): value is WorkspaceGrantScope {
  return value === "once" || value === "session" || value === "project" || value === "workspace";
}

interface WorkspaceAuditRow {
  id: string;
  run_id: string | null;
  session_id: string | null;
  task_id: string | null;
  tool_call_id: string | null;
  tool_name: string;
  operation: WorkspaceScopePermission;
  normalized_path: string;
  matched_root: string | null;
  workspace_scope_id: string | null;
  grant_id: string | null;
  permission_source: string | null;
  decision: "allowed" | "needs_confirmation" | "denied";
  reason: string;
  cross_workspace: number;
  path_risk: string;
  path_risk_tier: string;
  created_at: string;
}

function rowToAudit(row: WorkspaceAuditRow): WorkspaceAccessAuditRecord {
  return {
    id: row.id,
    runId: row.run_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    taskId: row.task_id ?? undefined,
    toolCallId: row.tool_call_id ?? undefined,
    toolName: row.tool_name,
    operation: row.operation,
    normalizedPath: row.normalized_path,
    matchedRoot: row.matched_root ?? undefined,
    workspaceScopeId: row.workspace_scope_id ?? undefined,
    grantId: row.grant_id ?? undefined,
    permissionSource: row.permission_source ?? undefined,
    decision: row.decision,
    reason: row.reason,
    crossWorkspace: row.cross_workspace === 1,
    pathRisk: row.path_risk,
    pathRiskTier: row.path_risk_tier,
    createdAt: row.created_at,
  };
}
