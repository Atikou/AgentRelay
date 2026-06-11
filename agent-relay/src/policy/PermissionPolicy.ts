import {
  ALL_PERMISSIONS,
  CONFIRMATION_REQUIRED,
  MODE_PERMISSIONS,
  type ToolPermission,
} from "../agent/permissions.js";
import type { Tool } from "../tools/types.js";

export {
  ALL_PERMISSIONS,
  CONFIRMATION_REQUIRED,
  MODE_PERMISSIONS,
  type ToolPermission,
};

/** 工具是否需用户确认。 */
export function toolNeedsConfirmation(tool: Tool): boolean {
  return CONFIRMATION_REQUIRED.includes(tool.permission);
}

/** 权限是否在允许集内。 */
export function isPermissionAllowed(
  permission: ToolPermission,
  allowed: ToolPermission[],
): boolean {
  return allowed.includes(permission);
}
