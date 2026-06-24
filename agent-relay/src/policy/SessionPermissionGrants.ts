import type { DatabaseSync } from "node:sqlite";

import type { ScopedApprovedPermissions } from "./permissionRequestTypes.js";

/** 会话级已批准的作用域权限（「本次会话都允许」），可落盘到 memory.db。 */
export class SessionPermissionGrants {
  private readonly grants = new Map<string, ScopedApprovedPermissions>();

  constructor(private readonly db?: DatabaseSync) {
    if (this.db) this.loadAllFromDb();
  }

  get(sessionId: string | undefined): ScopedApprovedPermissions | undefined {
    if (!sessionId) return undefined;
    const existing = this.grants.get(sessionId);
    return existing ? cloneScoped(existing) : undefined;
  }

  merge(sessionId: string, patch: ScopedApprovedPermissions): ScopedApprovedPermissions {
    const existing = this.grants.get(sessionId) ?? {};
    const merged = mergeScoped(existing, patch);
    this.grants.set(sessionId, merged);
    if (this.db) {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO session_permission_grants (session_id, grants_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             grants_json=excluded.grants_json,
             updated_at=excluded.updated_at`,
        )
        .run(sessionId, JSON.stringify(merged), now);
    }
    return cloneScoped(merged);
  }

  clear(sessionId: string): void {
    this.grants.delete(sessionId);
    if (this.db) {
      this.db.prepare(`DELETE FROM session_permission_grants WHERE session_id=?`).run(sessionId);
    }
  }

  private loadAllFromDb(): void {
    if (!this.db) return;
    const rows = this.db
      .prepare(`SELECT session_id, grants_json FROM session_permission_grants`)
      .all() as Array<{ session_id: string; grants_json: string }>;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.grants_json) as ScopedApprovedPermissions;
        if (parsed && typeof parsed === "object") {
          this.grants.set(row.session_id, parsed);
        }
      } catch {
        // skip corrupt row
      }
    }
  }
}

export const defaultSessionPermissionGrants = new SessionPermissionGrants();

function mergeScoped(
  base: ScopedApprovedPermissions,
  patch: ScopedApprovedPermissions,
): ScopedApprovedPermissions {
  const merged: ScopedApprovedPermissions = { ...base };
  for (const key of Object.keys(patch) as Array<keyof ScopedApprovedPermissions>) {
    const next = [...new Set([...(merged[key] ?? []), ...(patch[key] ?? [])])];
    if (next.length) merged[key] = next;
  }
  return merged;
}

function cloneScoped(value: ScopedApprovedPermissions): ScopedApprovedPermissions {
  const cloned: ScopedApprovedPermissions = {};
  for (const key of Object.keys(value) as Array<keyof ScopedApprovedPermissions>) {
    const items = value[key];
    if (items?.length) cloned[key] = [...items];
  }
  return cloned;
}
