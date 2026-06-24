import { intentForExplicitMode, runModeForIntent } from "../intentPatterns.js";
import { parseRunModeValue } from "../RunPolicyTypes.js";
import type { ModelTaskType } from "../../model/taskType.js";
import type { TaskContext } from "../task/TaskContext.js";
import { classifyIntentWithAI } from "./AIIntentClassifier.js";
import {
  detectContinuation,
  shouldInheritActiveTaskOnUncertain,
} from "./ContinuationDetector.js";
import type { IntentDecision } from "./IntentDecision.js";
import { resolveLegacyIntentFallback } from "./LegacyIntentFallback.js";
import type { SessionTaskManager } from "../task/SessionTaskManager.js";
import { defaultSessionTaskManager } from "../task/SessionTaskManager.js";

export interface EntryIntentRouteInput {
  requestedMode?: string;
  forceRequestedMode?: boolean;
  message?: string;
  taskType?: ModelTaskType;
  sessionId?: string;
  taskContext?: TaskContext;
}

/**
 * 新入口意图路由：
 * Session continuity → AI classifier → Legacy fallback
 */
export class EntryIntentRouter {
  constructor(private readonly sessionTasks: SessionTaskManager = defaultSessionTaskManager) {}

  resolve(input: EntryIntentRouteInput = {}): IntentDecision {
    const explicit = input.forceRequestedMode ? parseRunModeValue(input.requestedMode) : undefined;
    if (explicit) {
      const intent = intentForExplicitMode(explicit);
      const fallback = resolveLegacyIntentFallback({
        requestedMode: input.requestedMode,
        forceRequestedMode: true,
        message: input.message,
        taskType: input.taskType,
      });
      return {
        ...fallback,
        mode: explicit,
        intent,
        modeSource: "explicit",
        source: "explicit_mode",
        reason: "显式 mode 覆盖",
        confidence: 1,
      };
    }

    const sessionId = input.sessionId?.trim();
    const taskContext =
      input.taskContext ?? (sessionId ? this.sessionTasks.getContext(sessionId) : undefined);
    const message = input.message ?? "";

    if (sessionId) {
      const continuation = detectContinuation(message, taskContext);
      if (continuation.kind === "new_task") {
        this.sessionTasks.markInactive(sessionId);
      } else if (continuation.kind === "continuation" && continuation.inheritIntent && continuation.inheritWorkflowType) {
        return this.buildContinuationDecision({
          intent: continuation.inheritIntent,
          workflowType: continuation.inheritWorkflowType,
          reason: continuation.reason,
        });
      }
    }

    const aiDecision = classifyIntentWithAI({
      message,
      taskType: input.taskType,
      sessionId,
    });
    if (aiDecision && aiDecision.confidence >= 0.6) {
      return aiDecision;
    }

    const legacy = resolveLegacyIntentFallback({
      message,
      taskType: input.taskType,
    });

    if (sessionId && taskContext?.isActive && shouldInheritActiveTaskOnUncertain(taskContext, legacy.intent)) {
      return this.buildContinuationDecision({
        intent: taskContext.intent,
        workflowType: taskContext.workflowType,
        reason: `活跃任务覆盖 legacy ${legacy.intent}`,
      });
    }

    return legacy;
  }

  private buildContinuationDecision(input: {
    intent: IntentDecision["intent"];
    workflowType: IntentDecision["workflowType"];
    reason: string;
  }): IntentDecision {
    return {
      mode: runModeForIntent(input.intent),
      modeSource: "inferred",
      intent: input.intent,
      workflowType: input.workflowType,
      workflowPlan: null,
      isContinuation: true,
      isNewTask: false,
      confidence: 0.9,
      reason: input.reason,
      source: "session_continuation",
    };
  }
}

let _defaultEntryIntentRouter = new EntryIntentRouter();

export function wireEntryIntentRouter(sessionTasks?: SessionTaskManager): EntryIntentRouter {
  _defaultEntryIntentRouter = new EntryIntentRouter(sessionTasks ?? defaultSessionTaskManager);
  return _defaultEntryIntentRouter;
}

export const defaultEntryIntentRouter: EntryIntentRouter = new Proxy({} as EntryIntentRouter, {
  get(_target, prop: keyof EntryIntentRouter) {
    const value = _defaultEntryIntentRouter[prop];
    return typeof value === "function" ? value.bind(_defaultEntryIntentRouter) : value;
  },
});
