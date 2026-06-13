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
  confirmationRequest?: PermissionConfirmationRequest;
}

export interface PermissionConfirmationRequest {
  status: "waiting_confirmation" | "denied";
  title: string;
  message: string;
  tool: string;
  permission: ToolPermission;
  intent: AgentIntentType;
  permissionPolicy: UserPermissionPolicy;
  action: string;
  affects: {
    files: string[];
    commands: string[];
    networkTargets: string[];
  };
  risk: {
    tier: StructuredToolRisk["tier"];
    category: StructuredToolRisk["category"];
    summary: string;
    reasons: string[];
  };
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
    const risk = assessPermissionDeniedRisk(input.permission, reason, {
      toolName: input.toolName,
      input: input.input,
      shellPolicy: input.shellPolicy,
      networkPolicy: input.networkPolicy,
    });
    return {
      decision: "deny",
      reason,
      risk,
      confirmationRequest: buildConfirmationRequest(input, risk, "denied", "权限策略已拒绝"),
    };
  }

  if (input.permissionPolicy === "readOnly" && input.permission !== "read") {
    const reason = `权限策略 readOnly 不允许 ${input.permission} 操作`;
    const risk = assessPermissionDeniedRisk(input.permission, reason, {
      toolName: input.toolName,
      input: input.input,
      shellPolicy: input.shellPolicy,
      networkPolicy: input.networkPolicy,
    });
    return {
      decision: "deny",
      reason,
      risk,
      confirmationRequest: buildConfirmationRequest(input, risk, "denied", "权限策略已拒绝"),
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
      confirmationRequest: buildConfirmationRequest(input, risk, "waiting_confirmation", "等待确认写入操作"),
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
        confirmationRequest: buildConfirmationRequest(input, risk, "waiting_confirmation", "等待确认执行操作"),
      };
    }
    const reason = `权限策略 ${input.permissionPolicy} 不允许 ${input.permission} 操作`;
    const deniedRisk = assessPermissionDeniedRisk(input.permission, reason, {
      toolName: input.toolName,
      input: input.input,
      shellPolicy: input.shellPolicy,
      networkPolicy: input.networkPolicy,
    });
    return {
      decision: "deny",
      reason,
      risk: deniedRisk,
      confirmationRequest: buildConfirmationRequest(input, deniedRisk, "denied", "权限策略已拒绝"),
    };
  }

  if (input.permission === "dangerous") {
    if (input.permissionPolicy === "autoRun" && input.intent === "run") {
      return {
        decision: "needsConfirmation",
        reason: "dangerous 权限操作必须确认",
        risk,
        confirmationRequest: buildConfirmationRequest(input, risk, "waiting_confirmation", "等待确认高风险操作"),
      };
    }
    const reason = "dangerous 权限操作被策略拒绝";
    const deniedRisk = assessPermissionDeniedRisk(input.permission, reason, {
      toolName: input.toolName,
      input: input.input,
      shellPolicy: input.shellPolicy,
      networkPolicy: input.networkPolicy,
    });
    return {
      decision: "deny",
      reason,
      risk: deniedRisk,
      confirmationRequest: buildConfirmationRequest(input, deniedRisk, "denied", "权限策略已拒绝"),
    };
  }

  return { decision: "allow", risk };
}

function buildConfirmationRequest(
  input: PermissionGuardInput,
  risk: StructuredToolRisk,
  status: PermissionConfirmationRequest["status"],
  title: string,
): PermissionConfirmationRequest {
  const affects = extractAffectedTargets(input, risk);
  const action = describeAction(input);
  const targetText = [
    affects.files.length ? `文件：${affects.files.join(", ")}` : "",
    affects.commands.length ? `命令：${affects.commands.join(" && ")}` : "",
    affects.networkTargets.length ? `网络：${affects.networkTargets.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("；");
  return {
    status,
    title,
    message: `${action}${targetText ? `（${targetText}）` : ""}。风险：${risk.summary}`,
    tool: input.toolName,
    permission: input.permission,
    intent: input.intent,
    permissionPolicy: input.permissionPolicy,
    action,
    affects,
    risk: {
      tier: risk.tier,
      category: risk.category,
      summary: risk.summary,
      reasons: [...risk.reasons],
    },
  };
}

function describeAction(input: PermissionGuardInput): string {
  if (input.permission === "write") {
    if (input.toolName === "apply_patch") return "应用文件补丁";
    if (input.toolName === "write_file") return "写入工作区文件";
    return "执行写入类操作";
  }
  if (input.permission === "shell") return "执行 Shell 命令";
  if (input.permission === "network") return "访问网络资源";
  if (input.permission === "dangerous") return "执行高风险操作";
  return "执行工具调用";
}

function extractAffectedTargets(
  input: PermissionGuardInput,
  risk: StructuredToolRisk,
): PermissionConfirmationRequest["affects"] {
  const record = isRecord(input.input) ? input.input : {};
  const files = [
    readString(record.path),
    readString(record.file),
    ...readStringArray(record.files),
    ...readStringArray(record.paths),
  ].filter((value): value is string => Boolean(value));
  const command = readString(record.command);
  const url = readString(record.url) || readString(record.endpoint);
  const target = risk.target;
  return {
    files: unique(files),
    commands: command ? [command] : [],
    networkTargets: unique([url, target].filter((value): value is string => Boolean(value))),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function unique(values: string[]): string[] {
  return [...new Set(values)].slice(0, 20);
}
