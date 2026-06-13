import type { ModelTaskType } from "../model/taskType.js";
import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";
import type { ToolPermission } from "./permissions.js";

export type AgentRunMode = "chat" | "plan" | "implement" | "debug" | "review";

export type AgentStopReason = "completed" | "budget_exhausted" | "error" | "user_cancelled";

export type UserPermissionPolicy =
  | "readOnly"
  | "confirmBeforeEdit"
  | "autoEdit"
  | "confirmBeforeRun"
  | "autoRun";

export type UserPermissionPolicySource = "explicit" | "inferred";

export interface RunBudget {
  maxModelTurns: number;
  maxToolCalls: number;
  maxReadCalls: number;
  maxWriteCalls: number;
  maxShellCalls: number;
  maxRuntimeMs: number;
}

export interface RunBudgetUsage {
  modelTurns: number;
  toolCalls: number;
  readCalls: number;
  writeCalls: number;
  shellCalls: number;
  runtimeMs: number;
}

export type RunBudgetKey = keyof RunBudget;

export type AgentSuggestedAction = "continue_locating";

export interface LocationExplorationMeta {
  duplicateCount: number;
  newInformationCount: number;
  informationGain: number;
  lowYieldLoop: boolean;
}

export interface LocationExecutionMeta {
  usedLocateSteps: number;
  usedSearchCalls: number;
  usedListCalls: number;
  usedReadForLocationCalls: number;
  locatedFiles: string[];
  candidateFiles: string[];
  stopReason?: string;
  needsContinue: boolean;
  confidence?: number;
  exploration?: LocationExplorationMeta;
  suggestedAction?: AgentSuggestedAction;
}

export interface AgentWorkflowProposal {
  workflowType: Extract<AgentWorkflowType, "editWorkflow" | "generateFileWorkflow">;
  phase: "proposal";
  goal: string;
  intent: Extract<AgentIntentType, "edit" | "generate_file">;
  permissionPolicy: UserPermissionPolicy;
  requiredFields: string[];
  writeAllowedByPolicy: boolean;
  requiresConfirmationBeforeWrite: boolean;
}

export interface AgentExecutionMeta {
  mode: AgentRunMode;
  modeSource?: "explicit" | "inferred";
  intent?: AgentIntentType;
  workflowType?: AgentWorkflowType;
  permissionPolicy?: UserPermissionPolicy;
  permissionPolicySource?: UserPermissionPolicySource;
  workflowProposals?: AgentWorkflowProposal[];
  budget: RunBudget;
  usage: RunBudgetUsage;
  budgetExhausted?: RunBudgetKey;
  location?: LocationExecutionMeta;
  usedIterations: number;
  usedModelTurns: number;
  usedToolCalls: number;
  usedReadCalls: number;
  usedWriteCalls: number;
  usedShellCalls: number;
  stopReason: AgentStopReason;
  needsMoreBudget: boolean;
  suggestedBudget?: RunBudget;
  /** 按任务复杂度估算的建议工具调用次数（预算耗尽时返回）。 */
  suggestedToolCalls?: number;
  complexityTier?: "low" | "medium" | "high";
  /** 已成功完成的工具步骤摘要（预算耗尽时返回）。 */
  completedSteps?: string[];
  /** 推断的待继续步骤（预算耗尽时返回）。 */
  missingSteps?: string[];
  /** 定位不足或预算耗尽时的结构化继续动作。 */
  suggestedAction?: AgentSuggestedAction;
}

export interface RunPolicy {
  mode: AgentRunMode;
  modeSource: "explicit" | "inferred";
  intent: AgentIntentType;
  workflowType: AgentWorkflowType;
  permissionPolicy: UserPermissionPolicy;
  permissionPolicySource: UserPermissionPolicySource;
  budget: RunBudget;
  allowedPermissions: ToolPermission[];
  requireFinalAnswer: boolean;
  allowPartialAnswer: boolean;
  suggestedBudget: RunBudget;
  systemHint: string;
}

export interface ResolveRunPolicyInput {
  requestedMode?: string;
  requestedPermissionPolicy?: string;
  autoConfirm?: boolean;
  budget?: Partial<RunBudget>;
  taskType?: ModelTaskType;
  message?: string;
}

export function parseRunModeValue(mode: string | undefined): AgentRunMode | undefined {
  if (!mode) return undefined;
  const normalized = mode.trim().toLowerCase();
  if (
    normalized === "chat" ||
    normalized === "plan" ||
    normalized === "implement" ||
    normalized === "debug" ||
    normalized === "review"
  ) {
    return normalized;
  }
  return undefined;
}

export function parseUserPermissionPolicyValue(
  policy: string | undefined,
): UserPermissionPolicy | undefined {
  if (!policy) return undefined;
  const normalized = policy.trim();
  if (
    normalized === "readOnly" ||
    normalized === "confirmBeforeEdit" ||
    normalized === "autoEdit" ||
    normalized === "confirmBeforeRun" ||
    normalized === "autoRun"
  ) {
    return normalized;
  }
  return undefined;
}
