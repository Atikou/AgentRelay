import type { AgentNotification } from "../background/types.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { ModelTaskType } from "../model/taskType.js";
import type { ChatMessage } from "../model/types.js";
import type { AgentRoutingMeta } from "../model-router/agent-routing-summary.js";
import type { LoopChatFn, LoopChatResponse } from "../model-router/agent-chat-types.js";
import { assertWithinCostBudget, sumModelTurnCost } from "../util/costBudget.js";
import { redactPreview } from "../util/redact.js";
import { parseAction, type FinalAction, type ToolAction } from "./AgentActionParser.js";
import type { AgentRunSession } from "./AgentRunBootstrap.js";
import type { AgentRunFinalizeInput, AgentRunFinalizeResult } from "./AgentRunFinalizer.js";
import type { AgentModelTurnEvent } from "./AgentModelTurn.js";
import type { CapabilityEscalationRecord } from "./CapabilityEscalation.js";
import type { BudgetManager } from "./BudgetManager.js";
import { evaluateCompletionGuard } from "./completion/CompletionFinalGuard.js";
import type { Finalizer } from "./Finalizer.js";
import type { AgentIntentType } from "./IntentTypes.js";
import type { PausedRunSnapshot } from "./PausedRunStore.js";
import type { PlanHandoffStore } from "../policy/PlanHandoffStore.js";
import { planHandoffMessageForVariant } from "./planHandoffMessages.js";
import { FailedActionMemory } from "./recovery/FailedActionMemory.js";
import { RunToolResultCache } from "./recovery/RunToolResultCache.js";
import { cacheInvalidationPath } from "./recovery/SystemToolRecovery.js";
import type { RunBudgetKey, RunPolicy } from "./RunPolicyTypes.js";
import type { AgentToolStep } from "./toolStep.js";

export type AgentToolStepExecResult =
  | { kind: "step"; step: AgentToolStep }
  | { kind: "pause" | "budget"; result: AgentRunFinalizeResult };

export interface AgentReactLoopContext {
  chat: LoopChatFn;
  signal?: AbortSignal;
  sensitive?: boolean;
  taskType?: ModelTaskType;
  maxCostUsdPerRun?: number;
  maxModelTurns: number;
  budgetManager: BudgetManager;
  contextManager?: ContextManager;
  runId?: string;
  policy: RunPolicy;
  pausedRun?: PausedRunSnapshot;
  reconciledIntent?: AgentIntentType;
  capabilityEscalations: CapabilityEscalationRecord[];
  failedActionMemory: FailedActionMemory;
  toolResultCache: RunToolResultCache;
  finalizer: Finalizer;
  planHandoffStore: PlanHandoffStore;
  getEffectiveIntent: () => AgentIntentType;
  getModelTurnMetrics: () => Array<{
    costUsd?: number;
  }>;
  recordModelTurn: (metric: {
    iteration: number;
    success: boolean;
    client?: string;
    model?: string;
    location?: string;
    latencyMs: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    error?: string;
  }) => void;
  setRunRoutingMeta: (meta: AgentRoutingMeta) => void;
  getRunRoutingMeta: () => AgentRoutingMeta | undefined;
  onModelTurn?: (event: AgentModelTurnEvent) => void;
  onStep?: (step: AgentToolStep) => void;
  onToken?: (token: string) => void;
  assertNotCancelled: () => void;
  isCancelledError: (err: unknown) => boolean;
  makeToolCallId: (iteration: number, tool: string) => string;
  writeAgentDecisionTrace: (event: {
    iteration: number;
    action: "tool" | "final" | "parse_error" | "final_guard_rejected";
    tool?: string;
    toolCallId?: string;
    thought?: string;
    inputPreview?: string;
    rawPreview?: string;
    answerLength?: number;
    completionStatus?: string;
  }) => void;
  shouldCreatePlanHandoff: () => boolean;
  snapshotPausedRun: (input: {
    sessionId?: string;
    goal: string;
    system?: string;
    messages: ChatMessage[];
    steps: AgentToolStep[];
    modelTurns: number;
    resumeMode: "implement";
  }) => void;
  executeToolStep: (input: {
    action: ToolAction;
    iteration: number;
    toolCallId: string;
    steps: AgentToolStep[];
    goal: string;
    messages: ChatMessage[];
    sessionId?: string;
    system?: string;
    modelTurns: number;
    consumedNotifications: AgentNotification[];
  }) => Promise<AgentToolStepExecResult>;
  recordToolStepMessages: (input: {
    messages: ChatMessage[];
    step: AgentToolStep;
    steps: AgentToolStep[];
    goal: string;
    sessionId?: string;
  }) => void;
  maybeRunSystemRecovery: (input: {
    step: AgentToolStep;
    messages: ChatMessage[];
    steps: AgentToolStep[];
    goal: string;
    sessionId?: string;
    iteration: number;
  }) => Promise<void>;
  runEditAutoVerification: (
    step: AgentToolStep,
    steps: AgentToolStep[],
    iteration: number,
    goal: string,
  ) => Promise<AgentToolStep | undefined>;
  buildPartialAnswer: (
    steps: AgentToolStep[],
    budgetExhausted: RunBudgetKey,
    goal: string,
  ) => string;
  finishRun: (input: AgentRunFinalizeInput) => Promise<AgentRunFinalizeResult>;
}

/** ReAct 主循环：模型轮次 → parseAction → final/planHandoff/guard 或工具执行与后处理。 */
export async function runAgentReactLoop(
  ctx: AgentReactLoopContext,
  session: AgentRunSession,
): Promise<AgentRunFinalizeResult> {
  const {
    effectiveGoal,
    sessionId,
    pausedRun,
    system,
    injectNotifications,
    consumedNotifications,
  } = session;
  const messages = session.messages;
  const steps = session.steps;
  let modelTurns = session.modelTurns;
  const contextManager = ctx.contextManager;

  while (modelTurns < ctx.maxModelTurns) {
    ctx.assertNotCancelled();
    const runtimeExhausted = ctx.budgetManager.findRuntimeExhaustion();
    if (runtimeExhausted) {
      return await ctx.finishRun({
        answer: "",
        partialSummary: ctx.buildPartialAnswer(steps, runtimeExhausted, effectiveGoal),
        steps,
        iterations: modelTurns,
        reachedLimit: true,
        budgetExhausted: runtimeExhausted,
        consumedNotifications,
        sessionId,
        userMessage: effectiveGoal,
      });
    }

    const iteration = modelTurns + 1;
    modelTurns = iteration;
    ctx.onModelTurn?.({ iteration, phase: "started" });
    const modelStart = Date.now();
    let response: LoopChatResponse;
    try {
      assertWithinCostBudget(
        sumModelTurnCost(ctx.getModelTurnMetrics().map((m) => m.costUsd)),
        ctx.maxCostUsdPerRun,
      );
      response = await ctx.chat(
        {
          messages,
          temperature: 0.2,
          onToken: ctx.onToken,
          signal: ctx.signal,
        },
        {
          sensitive: ctx.sensitive,
          taskType: ctx.taskType,
          spentCostUsd: sumModelTurnCost(ctx.getModelTurnMetrics().map((m) => m.costUsd)),
          maxCostUsd: ctx.maxCostUsdPerRun,
        },
      );
      if (!ctx.getRunRoutingMeta() && response.routingMeta) {
        ctx.setRunRoutingMeta(response.routingMeta);
      }
      ctx.recordModelTurn({
        iteration,
        success: true,
        client: response.clientName,
        model: response.modelName,
        location: response.location,
        latencyMs: Math.round(response.latencyMs || Date.now() - modelStart),
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        costUsd: response.costUsd,
      });
      assertWithinCostBudget(
        sumModelTurnCost(ctx.getModelTurnMetrics().map((m) => m.costUsd)),
        ctx.maxCostUsdPerRun,
      );
    } catch (error) {
      if (ctx.isCancelledError(error)) throw error;
      ctx.recordModelTurn({
        iteration,
        success: false,
        latencyMs: Date.now() - modelStart,
        error: String(error),
      });
      throw error;
    }
    messages.push({ role: "assistant", content: response.content });

    const action = parseAction(response.content);
    if (!action) {
      ctx.onModelTurn?.({
        iteration,
        phase: "parse_error",
        contentPreview: redactPreview(response.content, 400),
        clientName: response.clientName,
        modelName: response.modelName,
        latencyMs: Math.round(response.latencyMs || Date.now() - modelStart),
      });
      ctx.writeAgentDecisionTrace({
        iteration,
        action: "parse_error",
        rawPreview: redactPreview(response.content, 300),
      });
      messages.push({
        role: "system",
        content:
          '上一条不是合法的 JSON。请只输出一个 JSON 对象：{"action":"tool",...} 或 {"action":"final","answer":"..."}。禁止把 JSON 放进字符串（错误示例："{"action":"final",...}"）。',
      });
      continue;
    }
    if (contextManager && sessionId && action.action !== "final") {
      contextManager.saveAssistantToolAction(sessionId, response.content, ctx.runId, {
        clientName: response.clientName,
        modelName: response.modelName,
      });
    }

    if (action.action === "final") {
      return await handleFinalAction(ctx, {
        action,
        response,
        iteration,
        modelStart,
        effectiveGoal,
        system,
        sessionId,
        pausedRun,
        messages,
        steps,
        consumedNotifications,
      });
    }

    const toolCallId = ctx.makeToolCallId(iteration, action.tool);
    ctx.onModelTurn?.({
      iteration,
      phase: "completed",
      action: "tool",
      tool: action.tool,
      thought: action.thought,
      contentPreview: redactPreview(response.content, 400),
      clientName: response.clientName,
      modelName: response.modelName,
      latencyMs: Math.round(response.latencyMs || Date.now() - modelStart),
    });
    ctx.writeAgentDecisionTrace({
      iteration,
      action: "tool",
      tool: action.tool,
      toolCallId,
      thought: action.thought,
      inputPreview: redactPreview(action.input ?? {}, 500),
    });

    const execResult = await ctx.executeToolStep({
      action,
      iteration,
      toolCallId,
      steps,
      goal: effectiveGoal,
      messages,
      sessionId,
      system,
      modelTurns,
      consumedNotifications,
    });
    if (execResult.kind === "pause" || execResult.kind === "budget") {
      return execResult.result;
    }
    if (execResult.kind !== "step") {
      continue;
    }
    const step = execResult.step;
    steps.push(step);
    ctx.onStep?.(step);
    if (step.blocked) {
      ctx.recordToolStepMessages({
        messages,
        step,
        steps,
        goal: effectiveGoal,
        sessionId,
      });
      continue;
    }
    ctx.recordToolStepMessages({
      messages,
      step,
      steps,
      goal: effectiveGoal,
      sessionId,
    });
    const invalidated = cacheInvalidationPath(step);
    if (invalidated) ctx.toolResultCache.invalidatePath(invalidated);
    await ctx.maybeRunSystemRecovery({
      step,
      messages,
      steps,
      goal: effectiveGoal,
      sessionId,
      iteration,
    });
    if (ctx.failedActionMemory.shouldForcePartialFinal(step)) {
      const recoverySummary = ctx.failedActionMemory.buildSummaryContext();
      if (recoverySummary) {
        messages.push({ role: "system", content: recoverySummary });
      }
      return await ctx.finishRun({
        answer: "",
        partialSummary: [
          ctx.finalizer.buildRecoveryExhaustedAnswer({ goal: effectiveGoal, steps }),
          step.error ?? "",
          recoverySummary ?? "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        steps,
        iterations: modelTurns,
        reachedLimit: false,
        stopReason: "recovery_partial",
        consumedNotifications,
        sessionId,
        userMessage: effectiveGoal,
      });
    }
    if (step.workflowPhaseBlocked && step.error) {
      messages.push({
        role: "system",
        content: `（系统）工作流写入门禁未满足，工具「${step.tool}」被阻塞：${step.error}。请先完成必需的只读预定位/方案/分析阶段，再调用写入类工具；勿重复无效写入尝试。`,
      });
    }
    const autoVerificationStep = await ctx.runEditAutoVerification(
      step,
      steps,
      iteration,
      effectiveGoal,
    );
    if (autoVerificationStep) {
      steps.push(autoVerificationStep);
      ctx.onStep?.(autoVerificationStep);
      ctx.recordToolStepMessages({
        messages,
        step: autoVerificationStep,
        steps,
        goal: effectiveGoal,
        sessionId,
      });
    }
    injectNotifications();

    const postToolRuntimeExhausted = ctx.budgetManager.findRuntimeExhaustion();
    if (postToolRuntimeExhausted) {
      return await ctx.finishRun({
        answer: "",
        partialSummary: ctx.buildPartialAnswer(steps, postToolRuntimeExhausted, effectiveGoal),
        steps,
        iterations: modelTurns,
        reachedLimit: true,
        budgetExhausted: postToolRuntimeExhausted,
        consumedNotifications,
        sessionId,
        userMessage: effectiveGoal,
      });
    }
  }

  return await ctx.finishRun({
    answer: "",
    partialSummary: ctx.buildPartialAnswer(steps, "maxModelTurns", effectiveGoal),
    steps,
    iterations: modelTurns,
    reachedLimit: true,
    budgetExhausted: "maxModelTurns",
    consumedNotifications,
    sessionId,
    userMessage: effectiveGoal,
  });
}

async function handleFinalAction(
  ctx: AgentReactLoopContext,
  input: {
    action: FinalAction;
    response: LoopChatResponse;
    iteration: number;
    modelStart: number;
    effectiveGoal: string;
    system?: string;
    sessionId?: string;
    pausedRun?: PausedRunSnapshot;
    messages: ChatMessage[];
    steps: AgentToolStep[];
    consumedNotifications: AgentNotification[];
  },
): Promise<AgentRunFinalizeResult> {
  const {
    action,
    response,
    iteration,
    modelStart,
    effectiveGoal,
    system,
    sessionId,
    pausedRun,
    messages,
    steps,
    consumedNotifications,
  } = input;
  const contextManager = ctx.contextManager;

  ctx.onModelTurn?.({
    iteration,
    phase: "completed",
    action: "final",
    contentPreview: redactPreview(action.answer, 400),
    clientName: response.clientName,
    modelName: response.modelName,
    latencyMs: Math.round(response.latencyMs || Date.now() - modelStart),
  });
  ctx.writeAgentDecisionTrace({
    iteration,
    action: "final",
    answerLength: action.answer?.length ?? 0,
  });

  if (!pausedRun && ctx.shouldCreatePlanHandoff() && action.answer.trim()) {
    const planVariant = ctx.policy.planVariant ?? "plan_only";
    const handoffMessage = planHandoffMessageForVariant(planVariant);
    const planHandoff = ctx.planHandoffStore.create({
      runId: ctx.runId ?? "unknown-run",
      sessionId,
      planMarkdown: action.answer,
      planVariant,
      message: handoffMessage,
    });
    ctx.snapshotPausedRun({
      sessionId,
      goal: effectiveGoal,
      system,
      messages,
      steps,
      modelTurns: iteration,
      resumeMode: "implement",
    });
    if (contextManager && sessionId) {
      contextManager.saveTrustedModelFinalAnswer(sessionId, action.answer, ctx.runId, {
        clientName: response.clientName,
        modelName: response.modelName,
      });
    }
    return await ctx.finishRun({
      answer: action.answer,
      steps,
      iterations: iteration,
      reachedLimit: false,
      consumedNotifications,
      sessionId,
      userMessage: effectiveGoal,
      stopReason: "awaiting_plan_handoff",
      planHandoff,
      awaitingPlanHandoff: true,
    });
  }

  const guard = evaluateCompletionGuard({
    goal: effectiveGoal,
    intent: ctx.getEffectiveIntent(),
    reconciledIntent: ctx.reconciledIntent,
    capabilityEscalations: ctx.capabilityEscalations,
    mode: ctx.policy.mode,
    answer: action.answer,
    steps,
  });
  if (!guard.accepted) {
    ctx.writeAgentDecisionTrace({
      iteration,
      action: "final_guard_rejected",
      rawPreview: redactPreview(action.answer, 400),
      completionStatus: guard.status,
    });
    if (contextManager && sessionId) {
      contextManager.saveRawModelFinal(sessionId, guard.rawModelAnswer ?? action.answer, ctx.runId, {
        clientName: response.clientName,
        modelName: response.modelName,
      });
      if (guard.guardedAnswer) {
        contextManager.saveGuardedFinalAnswer(sessionId, guard.guardedAnswer, ctx.runId);
      }
    }
    return await ctx.finishRun({
      answer: guard.visibleAnswer ?? guard.guardedAnswer ?? "",
      steps,
      iterations: iteration,
      reachedLimit: false,
      consumedNotifications,
      sessionId,
      userMessage: effectiveGoal,
      stopReason: guard.stopReason,
      completionGuard: guard,
    });
  }
  if (contextManager && sessionId) {
    if (guard.trustedForMemory) {
      contextManager.saveTrustedModelFinalAnswer(
        sessionId,
        guard.visibleAnswer ?? action.answer,
        ctx.runId,
        {
          clientName: response.clientName,
          modelName: response.modelName,
        },
      );
    } else if (guard.guardedAnswer) {
      contextManager.saveGuardedFinalAnswer(sessionId, guard.guardedAnswer, ctx.runId);
    } else {
      contextManager.saveRawModelFinal(sessionId, action.answer, ctx.runId, {
        clientName: response.clientName,
        modelName: response.modelName,
      });
    }
  }
  return await ctx.finishRun({
    answer: guard.visibleAnswer ?? action.answer,
    steps,
    iterations: iteration,
    reachedLimit: false,
    consumedNotifications,
    sessionId,
    userMessage: effectiveGoal,
    completionGuard: guard,
  });
}
