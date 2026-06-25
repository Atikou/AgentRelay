import type { ToolPermission } from "../core/permissions.js";
import type { AgentIntentType } from "./IntentTypes.js";
import type { BudgetManager } from "./BudgetManager.js";
import type { CapabilityEscalationRecord } from "./CapabilityEscalation.js";
import type { TaskCompletionContract, SideEffectKind } from "./completion/TaskCompletionContract.js";

export function resolveEffectiveIntent(
  policyIntent: AgentIntentType | undefined,
  reconciledIntent: AgentIntentType | undefined,
): AgentIntentType {
  return reconciledIntent ?? policyIntent ?? "answer";
}

export function augmentContractWithEscalations(
  contract: TaskCompletionContract,
  escalations: CapabilityEscalationRecord[] | undefined,
): TaskCompletionContract {
  if (!escalations?.length) return contract;
  const required = new Set<SideEffectKind>(contract.requiredSideEffects);
  for (const escalation of escalations) {
    for (const perm of escalation.targetSideEffects) {
      if (perm === "write" || perm === "dangerous") required.add("write");
      if (perm === "shell") required.add("shell");
    }
  }
  const requiredSideEffects = [...required];
  return {
    requiresSideEffect: requiredSideEffects.length > 0,
    requiredSideEffects,
  };
}

/** escalation 后若分项预算为 0 但目标能力需要 write/shell，抬升到建议预算下限。 */
export function applyEscalationBudget(
  manager: BudgetManager,
  targetSideEffects: ToolPermission[],
): void {
  const budget = manager.budget;
  const suggested = manager.suggestedBudget;
  if (
    (targetSideEffects.includes("write") || targetSideEffects.includes("dangerous")) &&
    budget.maxWriteCalls === 0
  ) {
    budget.maxWriteCalls = Math.max(1, suggested.maxWriteCalls || 2);
  }
  if (targetSideEffects.includes("shell") && budget.maxShellCalls === 0) {
    budget.maxShellCalls = Math.max(1, suggested.maxShellCalls || 2);
  }
}

export function formatCapabilityEscalationTimelineContent(input: {
  escalation: CapabilityEscalationRecord;
  permissionPolicy?: string;
  targetPath?: string;
  autoApproved?: boolean;
}): string {
  const lines = [
    input.escalation.reason,
    input.targetPath ? `目标：${input.targetPath}` : "",
    `权限策略：${input.permissionPolicy ?? "未指定"}`,
    input.autoApproved
      ? "权限：策略已自动放行，进入 PermissionGuard 校验后执行。"
      : "权限：将经 PermissionGuard 判定是否需要确认。",
  ];
  return lines.filter(Boolean).join("\n");
}
