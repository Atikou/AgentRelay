import type { ModelTaskType } from "../model/taskType.js";
import { parseRunModeValue, type AgentRunMode } from "./RunPolicyTypes.js";
import { defaultWorkflowPlanner, type WorkflowPlan } from "./WorkflowPlanner.js";
import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";
import { defaultWorkflowRouter } from "./WorkflowRouter.js";
import {
  intentForExplicitMode,
  isGeneralSubagentCollaborationRequest,
  matchFallbackIntent,
  matchUnicodeIntent,
  normalizeIntentText,
  runModeForIntent,
} from "./intentPatterns.js";
import { isAgentStepFailureFeedback } from "./agentFailureFeedback.js";

export type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";

export type IntentModeSource = "explicit" | "inferred";

export interface IntentRouteInput {
  requestedMode?: string;
  forceRequestedMode?: boolean;
  message?: string;
  taskType?: ModelTaskType;
}

export interface IntentRouteResult {
  mode: AgentRunMode;
  modeSource: IntentModeSource;
  intent: AgentIntentType;
  workflowType: AgentWorkflowType;
  workflowPlan: WorkflowPlan | null;
}

/**
 * 用户意图路由：统一入口下先识别内部意图，再映射到当前已实现的运行模式与预扫描工作流。
 */
export class IntentRouter {
  route(input: IntentRouteInput = {}): IntentRouteResult {
    const explicit = input.forceRequestedMode ? parseRunModeValue(input.requestedMode) : undefined;
    const intent = explicit ? intentForExplicitMode(explicit) : this.inferIntent(input);
    const mode = explicit ?? runModeForIntent(intent);
    const goal = input.message ?? "";
    return {
      mode,
      modeSource: explicit ? "explicit" : "inferred",
      intent,
      workflowType: defaultWorkflowRouter.routeIntent(intent).workflowType,
      workflowPlan: defaultWorkflowPlanner.plan(goal, mode, intent),
    };
  }

  inferMode(input: IntentRouteInput): AgentRunMode {
    return runModeForIntent(this.inferIntent(input));
  }

  inferIntent(input: IntentRouteInput): AgentIntentType {
    const raw = (input.message ?? "").trim();
    const text = normalizeIntentText(raw);
    if (!text && input.taskType === "codegen") return "edit";
    if (isGeneralSubagentCollaborationRequest(text)) return "answer";
    const unicodeIntent = matchUnicodeIntent(text);
    if (unicodeIntent) return unicodeIntent;

    const fallbackIntent = matchFallbackIntent(text);
    if (fallbackIntent) return fallbackIntent;

    // 粘贴的步骤失败输出：至少走 debug，避免落回 answer→chat 只读问答。
    if (isAgentStepFailureFeedback(raw)) return "debug";

    if (input.taskType === "codegen") return "edit";
    return "answer";
  }
}

export const defaultIntentRouter = new IntentRouter();
