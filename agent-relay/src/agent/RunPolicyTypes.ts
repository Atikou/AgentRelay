import type { ModelTaskType } from "../model/taskType.js";
import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";
import type { ToolPermission } from "../core/permissions.js";

export type AgentRunMode = "chat" | "plan" | "implement" | "debug" | "review";
export type AgentExecutionStage = "analyze" | "plan" | "execute" | "verify";

export type AgentStopReason =
  | "completed"
  | "budget_exhausted"
  | "error"
  | "user_cancelled"
  | "awaiting_permission"
  | "awaiting_plan_handoff";

export type PlanExecutionVariant = "plan_only" | "plan_wait_approval" | "plan_then_execute";

export type PlanAfterAction = "final" | "request_permission" | "request_permission_then_execute";

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
  permissionChecks: AgentWorkflowPermissionCheck[];
  permissionSummary: "write_allowed" | "confirmation_required" | "denied";
}

export interface AgentWorkflowPermissionCheck {
  toolName: "apply_patch" | "write_file";
  permission: Extract<ToolPermission, "write">;
  decision: "allow" | "needsConfirmation" | "deny";
  reason?: string;
  risk: {
    tier: "low" | "medium" | "high" | "critical";
    category: string;
    requiresConfirmation: boolean;
    policyBlocked: boolean;
  };
}

export interface AgentWorkflowDiffRecord {
  toolCallId?: string;
  tool: "write_file" | "apply_patch";
  path?: string;
  changeId?: string;
  beforeHash?: string;
  afterHash?: string;
  diff?: string;
  diffTruncated: boolean;
}

export interface AgentWorkflowVerificationRecord {
  workflowType: Extract<
    AgentWorkflowType,
    "editWorkflow" | "generateFileWorkflow" | "debugWorkflow" | "refactorWorkflow"
  >;
  writeToolCallId?: string;
  writeTool: "write_file" | "apply_patch";
  path?: string;
  changeId?: string;
  verificationToolCallId?: string;
  verificationTool: string;
  ok: boolean;
  blocked?: boolean;
  error?: string;
  outputPreview?: string;
}

export interface AgentWorkflowCorrectionRecord {
  workflowType: Extract<
    AgentWorkflowType,
    "editWorkflow" | "generateFileWorkflow" | "debugWorkflow" | "refactorWorkflow"
  >;
  phase: "correction" | "termination";
  path?: string;
  changeId?: string;
  writeToolCallId?: string;
  verificationToolCallId?: string;
  verificationTool: string;
  attempt: number;
  maxAttempts: number;
  limitReached: boolean;
  verificationError?: string;
}

export interface AgentWorkflowDebugAnalysis {
  workflowType: Extract<AgentWorkflowType, "debugWorkflow">;
  phase: "analysis";
  goal: string;
  intent: Extract<AgentIntentType, "debug">;
  permissionPolicy: UserPermissionPolicy;
  requiredFields: string[];
  suggestedTools: string[];
  writeAllowedByPolicy: boolean;
  requiresConfirmationBeforeWrite: boolean;
}

export interface AgentWorkflowWritePhase {
  workflowType: Extract<AgentWorkflowType, "editWorkflow" | "generateFileWorkflow" | "refactorWorkflow">;
  phase: "write";
  goal: string;
  intent: Extract<AgentIntentType, "edit" | "generate_file" | "refactor">;
  permissionPolicy: UserPermissionPolicy;
  writeTool: "write_file" | "apply_patch";
  proposalReady: boolean;
  readToolsBeforeWrite: number;
  gated: true;
}

export interface AgentWorkflowDebugFix {
  workflowType: Extract<AgentWorkflowType, "debugWorkflow">;
  phase: "fix";
  goal: string;
  permissionPolicy: UserPermissionPolicy;
  writeTool: "write_file" | "apply_patch";
  analysisReady: boolean;
  readToolsBeforeWrite: number;
  gated: true;
}

export interface AgentWorkflowRefactorPlan {
  workflowType: Extract<AgentWorkflowType, "refactorWorkflow">;
  phase: "plan";
  goal: string;
  intent: Extract<AgentIntentType, "refactor">;
  permissionPolicy: UserPermissionPolicy;
  requiredFields: string[];
  maxStages: number;
  suggestedTools: string[];
  writeAllowedByPolicy: boolean;
  requiresConfirmationBeforeWrite: boolean;
}

export interface AgentWorkflowInternalPlan {
  workflowType: AgentWorkflowType;
  phase: "implicit";
  goal: string;
  intent: AgentIntentType;
  permissionPolicy: UserPermissionPolicy;
  requiredFields: string[];
  complexitySignals: string[];
  /** 明确区分：内部轻量计划，不是用户可见计划模式。 */
  userVisiblePlanMode: false;
  maxSteps: number;
}

export type AgentWorkflowTaskState =
  | "idle"
  | "planning"
  | "waiting_confirmation"
  | "executing"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentWorkflowSwitch {
  switched: true;
  fromIntent: AgentIntentType;
  toIntent: AgentIntentType;
  fromWorkflowType: AgentWorkflowType;
  toWorkflowType: AgentWorkflowType;
  fromTaskState?: AgentWorkflowTaskState;
  sequence: number;
}

export interface AgentExecutionMeta {
  mode: AgentRunMode;
  executionStage?: AgentExecutionStage;
  planVariant?: PlanExecutionVariant;
  modeSource?: "explicit" | "inferred";
  intent?: AgentIntentType;
  workflowType?: AgentWorkflowType;
  permissionPolicy?: UserPermissionPolicy;
  permissionPolicySource?: UserPermissionPolicySource;
  workflowProposals?: AgentWorkflowProposal[];
  workflowDiffs?: AgentWorkflowDiffRecord[];
  workflowVerifications?: AgentWorkflowVerificationRecord[];
  workflowCorrections?: AgentWorkflowCorrectionRecord[];
  workflowWritePhases?: AgentWorkflowWritePhase[];
  workflowDebugFixes?: AgentWorkflowDebugFix[];
  workflowDebugAnalyses?: AgentWorkflowDebugAnalysis[];
  workflowRefactorPlans?: AgentWorkflowRefactorPlan[];
  workflowInternalPlans?: AgentWorkflowInternalPlan[];
  workflowTaskState?: AgentWorkflowTaskState;
  workflowSwitch?: AgentWorkflowSwitch;
  workflowState?: import("./WorkflowStateCenter.js").WorkflowStateSnapshot;
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
  /** 用户可读执行状态（非 mode）。 */
  userFacingState?: import("./presentation/ExecutionStatePresenter.js").UserFacingExecutionState;
  userFacingLabel?: string;
  /** 入口意图决策来源（session_continuation / ai_classifier / legacy_fallback）。 */
  intentDecisionSource?: import("./routing/IntentDecision.js").IntentDecisionSource;
  isContinuation?: boolean;
  intentDecisionReason?: string;
  intentDecisionConfidence?: number;
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
  executionStage: AgentExecutionStage;
  modeSource: "explicit" | "inferred";
  intent: AgentIntentType;
  workflowType: AgentWorkflowType;
  permissionPolicy: UserPermissionPolicy;
  permissionPolicySource: UserPermissionPolicySource;
  planVariant?: PlanExecutionVariant;
  afterPlan: PlanAfterAction;
  budget: RunBudget;
  allowedPermissions: ToolPermission[];
  requireFinalAnswer: boolean;
  allowPartialAnswer: boolean;
  suggestedBudget: RunBudget;
  systemHint: string;
  intentDecisionSource?: import("./routing/IntentDecision.js").IntentDecisionSource;
  isContinuation?: boolean;
  intentDecisionReason?: string;
  intentDecisionConfidence?: number;
}

export interface ResolveRunPolicyInput {
  requestedMode?: string;
  forceMode?: boolean;
  sessionId?: string;
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
