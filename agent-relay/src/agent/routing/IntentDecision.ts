import type { AgentIntentType, AgentWorkflowType } from "../IntentTypes.js";
import type { AgentRunMode } from "../RunPolicyTypes.js";
import type { WorkflowPlan } from "../WorkflowPlanner.js";

export type IntentDecisionSource =
  | "explicit_mode"
  | "session_continuation"
  | "ai_classifier"
  | "legacy_fallback";

export interface IntentDecision {
  mode: AgentRunMode;
  modeSource: "explicit" | "inferred";
  intent: AgentIntentType;
  workflowType: AgentWorkflowType;
  workflowPlan: WorkflowPlan | null;
  isContinuation: boolean;
  isNewTask: boolean;
  needsWrite?: boolean;
  needsRunCommand?: boolean;
  confidence: number;
  reason: string;
  source: IntentDecisionSource;
}
