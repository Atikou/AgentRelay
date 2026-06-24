import type { AgentIntentType, AgentWorkflowType } from "../IntentTypes.js";

/** 会话内连续任务阶段（内部，非用户 mode）。 */
export type TaskPhase =
  | "idle"
  | "analyzing"
  | "planning"
  | "editing"
  | "debugging"
  | "verifying"
  | "waiting_approval"
  | "completed"
  | "failed";

/** 单个会话内的连续任务上下文。 */
export interface TaskContext {
  sessionId: string;
  taskId?: string;
  goal?: string;
  currentPhase: TaskPhase;
  intent: AgentIntentType;
  workflowType: AgentWorkflowType;
  lastRunId?: string;
  lastFailure?: string;
  relatedFiles?: string[];
  hasPendingPlanHandoff?: boolean;
  hasPendingPermission?: boolean;
  isActive: boolean;
  updatedAt: string;
}

export interface UpdateTaskContextFromRunInput {
  sessionId: string;
  taskId?: string;
  goal: string;
  intent: AgentIntentType;
  workflowType: AgentWorkflowType;
  runId?: string;
  stopReason?: string;
  workflowTaskState?: string;
  failed?: boolean;
  failureSummary?: string;
  relatedFiles?: string[];
}
