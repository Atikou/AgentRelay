import type { ScopedApprovedPermissions } from "./permissionRequestTypes.js";

/** 会话级已批准的作用域权限（「本次会话都允许」）。 */
export class SessionPermissionGrants {
  private readonly grants = new Map<string, ScopedApprovedPermissions>();

  get(sessionId: string | undefined): ScopedApprovedPermissions | undefined {
    if (!sessionId) return undefined;
    const existing = this.grants.get(sessionId);
    return existing ? cloneScoped(existing) : undefined;
  }

  merge(sessionId: string, patch: ScopedApprovedPermissions): ScopedApprovedPermissions {
    const existing = this.grants.get(sessionId) ?? {};
    const merged = mergeScoped(existing, patch);
    this.grants.set(sessionId, merged);
    return cloneScoped(merged);
  }

  clear(sessionId: string): void {
    this.grants.delete(sessionId);
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
