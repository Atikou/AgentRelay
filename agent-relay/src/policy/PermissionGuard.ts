import type { AgentIntentType } from "../agent/IntentTypes.js";
import type { ToolPermission } from "../agent/permissions.js";
import type { UserPermissionPolicy } from "../agent/RunPolicyTypes.js";
import { assessPermissionDeniedRisk, assessToolRisk, type StructuredToolRisk } from "./ToolRiskAssessment.js";
import type { NetworkPolicy } from "./NetworkPolicy.js";
import type { ShellPolicy } from "./ShellPolicy.js";

export type PermissionGuardDecisionKind = "allow" | "needsConfirmation" | "deny";

export interface PermissionGuardDecision {
  decision: PermissionGuardDecisionKind;
  reason?: string;
  risk: StructuredToolRisk;
}

export interface PermissionGuardInput {
  intent: AgentIntentType;
  permissionPolicy: UserPermissionPolicy;
  toolName: string;
  permission: ToolPermission;
  input: unknown;
  allowedPermissions: ToolPermission[];
  shellPolicy?: ShellPolicy;
  networkPolicy?: NetworkPolicy;
}

export function evaluatePermissionGuard(input: PermissionGuardInput): PermissionGuardDecision {
  if (!input.allowedPermissions.includes(input.permission)) {
    const reason = `当前模式不允许的权限：${input.permission}`;
    return {
      decision: "deny",
      reason,
      risk: assessPermissionDeniedRisk(input.permission, reason, {
        toolName: input.toolName,
        input: input.input,
        shellPolicy: input.shellPolicy,
        networkPolicy: input.networkPolicy,
      }),
    };
  }

  if (input.permissionPolicy === "readOnly" && input.permission !== "read") {
    const reason = `权限策略 readOnly 不允许 ${input.permission} 操作`;
    return {
      decision: "deny",
      reason,
      risk: assessPermissionDeniedRisk(input.permission, reason, {
        toolName: input.toolName,
        input: input.input,
        shellPolicy: input.shellPolicy,
        networkPolicy: input.networkPolicy,
      }),
    };
  }

  const risk = assessToolRisk({
    toolName: input.toolName,
    permission: input.permission,
    input: input.input,
    shellPolicy: input.shellPolicy,
    networkPolicy: input.networkPolicy,
  });

  if (input.permission === "read") {
    return { decision: "allow", risk };
  }

  if (input.permission === "write") {
    if (input.permissionPolicy === "autoEdit" || input.permissionPolicy === "autoRun") {
      return { decision: "allow", risk };
    }
    return {
      decision: "needsConfirmation",
      reason: `权限策略 ${input.permissionPolicy} 要求确认写入操作`,
      risk,
    };
  }

  if (input.permission === "shell" || input.permission === "network") {
    if (input.permissionPolicy === "autoRun") {
      return { decision: "allow", risk };
    }
    if (input.permissionPolicy === "confirmBeforeRun") {
      return {
        decision: "needsConfirmation",
        reason: `权限策略 ${input.permissionPolicy} 要求确认执行操作`,
        risk,
      };
    }
    const reason = `权限策略 ${input.permissionPolicy} 不允许 ${input.permission} 操作`;
    return {
      decision: "deny",
      reason,
      risk: assessPermissionDeniedRisk(input.permission, reason, {
        toolName: input.toolName,
        input: input.input,
        shellPolicy: input.shellPolicy,
        networkPolicy: input.networkPolicy,
      }),
    };
  }

  if (input.permission === "dangerous") {
    if (input.permissionPolicy === "autoRun" && input.intent === "run") {
      return { decision: "needsConfirmation", reason: "dangerous 权限操作必须确认", risk };
    }
    const reason = "dangerous 权限操作被策略拒绝";
    return {
      decision: "deny",
      reason,
      risk: assessPermissionDeniedRisk(input.permission, reason, {
        toolName: input.toolName,
        input: input.input,
        shellPolicy: input.shellPolicy,
        networkPolicy: input.networkPolicy,
      }),
    };
  }

  return { decision: "allow", risk };
}
