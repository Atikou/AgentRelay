import { intentForExplicitMode, runModeForIntent } from "../intentPatterns.js";
import { parseRunModeValue } from "../RunPolicyTypes.js";
import type { ModelTaskType } from "../../model/taskType.js";
import type { TaskContext } from "../task/TaskContext.js";
import {
  classifyIntentWithAIAsync,
  recordIntentClassifierDiff,
} from "./AIIntentClassifier.js";
import { shouldInheritActiveTaskOnUncertain } from "./ContinuationDetector.js";
import { extractMessageContinuationSignals } from "./MessageSignalExtractor.js";
import {
  evaluateTaskContinuation,
  shouldGuardrailOverrideAiClassifier,
  type TaskContinuationDecision,
} from "./TaskContinuationEngine.js";
import { evaluateTaskBoundary, workflowSatisfiesSideEffects } from "./TaskBoundaryDecision.js";
import type { IntentDecision } from "./IntentDecision.js";
import { resolveLegacyIntentFallback } from "./LegacyIntentFallback.js";
import type { SessionTaskManager } from "../task/SessionTaskManager.js";
import { defaultSessionTaskManager } from "../task/SessionTaskManager.js";
import { resolveWorkflow } from "./WorkflowResolver.js";

export interface EntryIntentRouteInput {
  requestedMode?: string;
  forceRequestedMode?: boolean;
  message?: string;
  taskType?: ModelTaskType;
  sessionId?: string;
  taskContext?: TaskContext;
}

/**
 * 入口意图路由：
 * MessageSignalExtractor → TaskBoundary → TaskContinuation → AI/Legacy 语义候选
 * → WorkflowResolver（IntentSemanticAdjudicator + 副作用兼容重解析）
 */
export class EntryIntentRouter {
  constructor(private readonly sessionTasks: SessionTaskManager = defaultSessionTaskManager) {}

  resolve(input: EntryIntentRouteInput = {}): IntentDecision {
    return this.finalizeDecision(input, null);
  }

  async resolveAsync(input: EntryIntentRouteInput = {}): Promise<IntentDecision> {
    const sessionId = input.sessionId?.trim();
    const taskContext =
      input.taskContext ?? (sessionId ? this.sessionTasks.getContext(sessionId) : undefined);
    const aiDecision = await classifyIntentWithAIAsync({
      message: input.message ?? "",
      taskType: input.taskType,
      sessionId,
      taskContext,
    });
    return this.finalizeDecision(input, aiDecision);
  }

  private finalizeDecision(
    input: EntryIntentRouteInput,
    aiDecision: IntentDecision | null,
  ): IntentDecision {
    const explicit = input.forceRequestedMode ? parseRunModeValue(input.requestedMode) : undefined;
    if (explicit) {
      const fallback = resolveLegacyIntentFallback({
        requestedMode: input.requestedMode,
        forceRequestedMode: true,
        message: input.message,
        taskType: input.taskType,
      });
      const intent = intentForExplicitMode(explicit);
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
    const signals = extractMessageContinuationSignals(message);
    const boundary = evaluateTaskBoundary(message, taskContext, signals);
    let continuation = evaluateTaskContinuation(message, taskContext, signals);

    if (boundary.breaksContinuation) {
      if (sessionId) this.sessionTasks.markInactive(sessionId);
      continuation = {
        kind: "new_task",
        score: 1,
        reason: boundary.reason,
        signals: {
          ...continuation.signals,
          breaksContinuation: true,
          boundaryBreak: true,
        },
      };
    } else if (sessionId && continuation.kind === "new_task") {
      this.sessionTasks.markInactive(sessionId);
    }

    if (
      sessionId &&
      continuation.kind === "inherit" &&
      continuation.inheritIntent &&
      continuation.inheritWorkflowType &&
      workflowSatisfiesSideEffects(continuation.inheritWorkflowType, boundary.requiredSideEffects)
    ) {
      return this.buildContinuationDecision({
        continuation,
        taskContext,
        reason: continuation.reason,
        source: "task_continuation",
      });
    }

    const legacy = resolveLegacyIntentFallback({
      message,
      taskType: input.taskType,
    });

    recordIntentClassifierDiff({
      sessionId,
      message,
      aiDecision,
      legacyIntent: legacy.intent,
    });

    if (aiDecision && aiDecision.confidence >= 0.6) {
      if (aiDecision.isNewTask && sessionId) {
        this.sessionTasks.markInactive(sessionId);
      }

      if (
        taskContext &&
        !boundary.breaksContinuation &&
        shouldGuardrailOverrideAiClassifier({
          ctx: taskContext,
          aiIntent: aiDecision.intent,
          aiIsContinuation: aiDecision.isContinuation === true,
          continuation,
        })
      ) {
        return this.buildContinuationDecision({
          continuation: {
            ...continuation,
            kind: "inherit",
            inheritIntent: taskContext.intent,
            inheritWorkflowType: taskContext.workflowType,
            inheritedTaskId: taskContext.taskId,
            reason: `AI 降级为 ${aiDecision.intent}，任务延续守卫继承活跃任务`,
          },
          taskContext,
          reason: `AI 降级为 ${aiDecision.intent}，任务延续守卫继承活跃任务`,
          source: "task_continuation",
          aiOverridden: true,
        });
      }

      return resolveWorkflow({
        message,
        candidate: aiDecision,
        candidateSource: "ai_classifier",
        signals,
        boundary,
        taskContext,
        taskType: input.taskType,
      });
    }

    if (
      sessionId &&
      taskContext?.isActive &&
      !boundary.breaksContinuation &&
      shouldInheritActiveTaskOnUncertain(taskContext, legacy.intent)
    ) {
      return this.buildContinuationDecision({
        continuation: {
          kind: "inherit",
          score: continuation.score,
          reason: `活跃任务覆盖 legacy ${legacy.intent}`,
          inheritIntent: taskContext.intent,
          inheritWorkflowType: taskContext.workflowType,
          inheritedTaskId: taskContext.taskId,
          signals: continuation.signals,
        },
        taskContext,
        reason: `活跃任务覆盖 legacy ${legacy.intent}`,
        source: "session_continuation",
      });
    }

    return resolveWorkflow({
      message,
      candidate: legacy,
      candidateSource: "legacy_fallback",
      signals,
      boundary,
      taskContext,
      taskType: input.taskType,
    });
  }

  private buildContinuationDecision(input: {
    continuation: TaskContinuationDecision;
    taskContext?: TaskContext;
    reason: string;
    source: IntentDecision["source"];
    aiOverridden?: boolean;
  }): IntentDecision {
    const intent = input.continuation.inheritIntent!;
    return {
      mode: runModeForIntent(intent),
      modeSource: "inferred",
      intent,
      workflowType: input.continuation.inheritWorkflowType!,
      workflowPlan: null,
      isContinuation: true,
      isNewTask: false,
      confidence: Math.max(0.85, input.continuation.score),
      reason: input.reason,
      source: input.source,
      inheritedTaskId: input.continuation.inheritedTaskId ?? input.taskContext?.taskId,
      previousWorkflowType: input.taskContext?.workflowType,
      continuationScore: input.continuation.score,
      continuationSignals: input.continuation.signals,
      aiOverridden: input.aiOverridden,
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
