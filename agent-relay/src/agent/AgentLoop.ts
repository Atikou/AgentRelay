import type { AgentNotification } from "../background/types.js";
import { readMergeCount } from "../background/NotificationQueue.js";
import type { NotificationQueue } from "../background/NotificationQueue.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { ModelTaskType } from "../model/taskType.js";
import type { ChatMessage, ChatRequest, ModelResponse } from "../model/types.js";
import type { AgentPromptStrategySummary, AgentRouterDecisionSummary, AgentRoutingMeta } from "../model-router/agent-routing-summary.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { AgentStepPlan } from "../plan/types.js";
import { assertWithinCostBudget, sumModelTurnCost } from "../util/costBudget.js";
import { wrapUntrustedToolOutput } from "../util/injection.js";
import { redactPreview } from "../util/redact.js";
import { EditAutoVerificationWorkflow } from "./EditAutoVerificationWorkflow.js";
import { EditExecutionWorkflow } from "./EditExecutionWorkflow.js";
import { EditWriteWorkflow } from "./EditWriteWorkflow.js";
import { DebugFixWorkflow } from "./DebugFixWorkflow.js";
import { EditVerificationWorkflow } from "./EditVerificationWorkflow.js";
import { MAX_WORKFLOW_CORRECTION_ATTEMPTS, WorkflowCorrectionWorkflow } from "./WorkflowCorrectionWorkflow.js";
import { hasPlanningPhaseArtifacts, resolveWorkflowTaskState } from "./WorkflowTaskState.js";
import { WorkflowExecutor } from "./WorkflowExecutor.js";
import {
  defaultWorkflowSessionStore,
  renderWorkflowSwitchContext,
  resolveWorkflowSwitch,
} from "./WorkflowSessionSwitch.js";
import { buildWorkflowState } from "./WorkflowStateCenter.js";
import { assessWorkflowWriteGate } from "./WorkflowWriteGate.js";
import {
  buildToolResultLayers,
  clipModelToolJson,
} from "./ToolResultLayers.js";
import { type ToolPermission } from "./permissions.js";
import {
  resolveEffectivePermissions,
} from "../policy/PermissionPolicy.js";
import { evaluatePermissionGuard } from "../policy/PermissionGuard.js";
import type { AgentToolStep } from "./toolStep.js";
import { BudgetManager } from "./BudgetManager.js";
import { defaultFinalizer } from "./Finalizer.js";
import { defaultRunPolicyManager } from "./RunPolicy.js";
import {
  type AgentExecutionMeta,
  type AgentRunMode,
  type AgentStopReason,
  type AgentWorkflowDebugAnalysis,
  type AgentWorkflowDiffRecord,
  type AgentWorkflowProposal,
  type AgentWorkflowCorrectionRecord,
  type AgentWorkflowDebugFix,
  type AgentWorkflowInternalPlan,
  type AgentWorkflowRefactorPlan,
  type AgentWorkflowSwitch,
  type AgentWorkflowVerificationRecord,
  type AgentWorkflowWritePhase,
  type LocationExecutionMeta,
  type RunBudget,
  type RunBudgetKey,
  type RunPolicy,
} from "./RunPolicyTypes.js";
import type { RunStateStore } from "../orchestrator/RunStateStore.js";
import type { ProjectIndex } from "../context/ProjectIndex.js";
import {
  buildRunStateFromAgentRun,
  type RunState,
} from "../orchestrator/runStateTypes.js";

export interface LoopChatResponse extends ModelResponse {
  /** Smart 路由路径：本轮模型调用的决策与提示策略（首轮回传至 Agent 响应）。 */
  routingMeta?: AgentRoutingMeta;
}

export type LoopChatFn = (
  req: ChatRequest,
  opts?: {
    sensitive?: boolean;
    taskType?: ModelTaskType;
    spentCostUsd?: number;
    maxCostUsd?: number;
  },
) => Promise<LoopChatResponse>;

export interface AgentRunResult {
  answer: string;
  steps: AgentToolStep[];
  iterations: number;
  /** 因达到运行预算而未给出 final 答案时为 true。 */
  reachedLimit: boolean;
  /** 本次运行实际生效的模式、预算、调用计数与停止原因。 */
  executionMeta: AgentExecutionMeta;
  /** 首轮模型调用的 Smart 路由摘要（默认 Smart 路径；显式 clientName 时省略）。 */
  routerDecision?: AgentRouterDecisionSummary;
  /** 首轮模型调用的提示策略（temperature/风格/hints）。 */
  promptStrategy?: AgentPromptStrategySummary;
  /** 本轮在安全点消费的系统通知（如后台任务完成）。 */
  notifications?: AgentNotification[];
  /** M6：持久化会话 id（启用 ContextManager 时返回）。 */
  sessionId?: string;
  /** M6：本轮是否触发了历史压缩。 */
  compressed?: boolean;
}

interface AgentModelTurnMetric {
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
}

export interface AgentLoopOptions {
  chat: LoopChatFn;
  registry: ToolRegistry;
  workspaceRoot: string;
  /** 暴露给模型/可执行的权限集，默认任务模式全集。 */
  allowedPermissions?: ToolPermission[];
  /** 项目级权限上限（来自 config.security.permissions）。 */
  projectAllowedPermissions?: ToolPermission[];
  /** 子 Agent 角色上限（仅子 Agent 路径传入）。 */
  roleAllowedPermissions?: ToolPermission[];
  /** 运行模式；未传时可由上层 RunPolicy 推断，默认 chat。 */
  mode?: AgentRunMode;
  /** 用户侧权限策略；本阶段仅用于元信息与后续 PermissionGuard 铺垫。 */
  permissionPolicy?: string;
  /** 上层解析好的运行策略。 */
  policy?: RunPolicy;
  budget?: Partial<RunBudget>;
  /** 自动确认副作用工具（写/命令/联网/危险）。false 时这些工具会被阻塞。 */
  autoConfirm?: boolean;
  sensitive?: boolean;
  taskType?: ModelTaskType;
  trace?: TraceLogger;
  /** 每发生一步工具调用时回调（便于流式回显）。 */
  onStep?: (step: AgentToolStep) => void;
  /** 模型 token 流式增量（需 ModelClient 支持且 request 传入 onToken）。 */
  onToken?: (delta: string) => void;
  /** 单次 Run 费用上限（USD）。 */
  maxCostUsdPerRun?: number;
  /** 通知队列：仅在安全点 drain 后注入上下文。 */
  notificationQueue?: NotificationQueue;
  /** M6：上下文压缩与持久化（可选）。 */
  contextManager?: ContextManager;
  /** M6：已有会话 id；未提供时自动创建。 */
  sessionId?: string;
  /** 编排 Run id，写入 trace 与工具审计。 */
  runId?: string;
  taskId?: string;
  requestId?: string;
  /** 预算耗尽时持久化续跑状态。 */
  runStateStore?: RunStateStore;
  /** 项目索引：写入 RunState.location 的 index 统计。 */
  projectIndex?: ProjectIndex;
  /** 从 RunStateStore 恢复的续跑上下文。 */
  resumeState?: RunState;
}

interface ToolAction {
  action: "tool";
  tool: string;
  input?: Record<string, unknown>;
  thought?: string;
}
interface FinalAction {
  action: "final";
  answer: string;
}
type AgentAction = ToolAction | FinalAction;

/**
 * 基础 Agent 对话循环（M1）。
 *
 * 采用可移植的 ReAct 风格 JSON 协议：模型每轮只输出一个 JSON——要么请求调用一个工具，
 * 要么给出最终答案。工具经 ToolRegistry 执行（含校验/权限/风险/超时），结果回灌给模型继续推理。
 * 不依赖各后端的原生 function-calling，本地与远程模型均可用。
 */
export class AgentLoop {
  private readonly allowed: ToolPermission[];
  private readonly budgetManager: BudgetManager;
  private readonly policy: RunPolicy;
  private readonly finalizer = defaultFinalizer;
  private modelTurnMetrics: AgentModelTurnMetric[] = [];
  private runRoutingMeta?: AgentRoutingMeta;
  private workflowProposals: AgentWorkflowProposal[] = [];
  private workflowDebugAnalyses: AgentWorkflowDebugAnalysis[] = [];
  private workflowRefactorPlans: AgentWorkflowRefactorPlan[] = [];
  private workflowInternalPlans: AgentWorkflowInternalPlan[] = [];
  private workflowWritePhases: AgentWorkflowWritePhase[] = [];
  private workflowDebugFixes: AgentWorkflowDebugFix[] = [];
  private workflowSwitch?: AgentWorkflowSwitch;
  private pendingWritePhaseContext?: string;

  constructor(private readonly options: AgentLoopOptions) {
    this.policy =
      options.policy ??
      defaultRunPolicyManager.resolve({
        requestedMode: options.mode,
        requestedPermissionPolicy: options.permissionPolicy ?? (options.autoConfirm ? "autoEdit" : undefined),
        autoConfirm: options.autoConfirm,
        budget: options.budget,
        taskType: options.taskType,
      });
    const resolved = resolveEffectivePermissions({
      projectAllowed: options.projectAllowedPermissions,
      modeAllowed: this.policy.allowedPermissions,
      modeSource: `run.mode=${this.policy.mode}`,
      roleAllowed: options.roleAllowedPermissions,
      roleSource: options.roleAllowedPermissions ? "subagent.role" : undefined,
      userGranted: options.allowedPermissions,
      userSource: "agent.allowedPermissions",
      strictUserGrant: options.allowedPermissions != null,
    });
    this.allowed = resolved.allowed;
    this.budgetManager = defaultRunPolicyManager.createBudgetManager(this.policy);
  }

  private get budget(): RunBudget {
    return this.budgetManager.budget;
  }

  async run(userMessage: string, system?: string): Promise<AgentRunResult> {
    this.budgetManager.markRunStarted();
    this.modelTurnMetrics = [];
    this.runRoutingMeta = undefined;
    this.workflowProposals = [];
    this.workflowDebugAnalyses = [];
    this.workflowRefactorPlans = [];
    this.workflowInternalPlans = [];
    this.workflowWritePhases = [];
    this.workflowDebugFixes = [];
    this.workflowSwitch = undefined;
    this.pendingWritePhaseContext = undefined;
    const isResume = Boolean(this.options.resumeState);
    const effectiveGoal = isResume ? this.options.resumeState!.goal : userMessage;
    const ctx = this.options.contextManager;
    let sessionId = this.options.resumeState?.sessionId ?? this.options.sessionId;
    if (ctx && !sessionId) {
      sessionId = ctx.createSession().id;
    }
    if (ctx && sessionId && !isResume) {
      ctx.saveUserMessage(sessionId, userMessage);
    }

    const messages: ChatMessage[] = ctx && sessionId
      ? ctx.buildChatMessages(
          await ctx.restoreContextPackage(sessionId, effectiveGoal),
          this.buildSystemPrompt(system),
          { phase: "pre_call", currentUser: isResume ? "继续上次计划扫描" : effectiveGoal },
        )
      : [
          { role: "system", content: this.buildSystemPrompt(system) },
          { role: "user", content: effectiveGoal },
        ];
    const steps: AgentToolStep[] = isResume
      ? [...(this.options.resumeState?.completedToolSteps ?? [])]
      : [];
    const consumedNotifications: AgentNotification[] = [];

    const injectNotifications = () => {
      const notes = this.drainNotifications();
      if (notes.length === 0) return;
      consumedNotifications.push(...notes);
      const rendered = renderNotifications(notes);
      const wrapped = wrapUntrustedToolOutput("notification", rendered);
      messages.push({
        role: "user",
        content: typeof wrapped === "string" ? wrapped : JSON.stringify(wrapped),
      });
    };

    injectNotifications();

    if (sessionId && !isResume && this.policy.intent && this.policy.workflowType) {
      this.workflowSwitch = resolveWorkflowSwitch({
        previous: defaultWorkflowSessionStore.get(sessionId),
        current: {
          intent: this.policy.intent,
          workflowType: this.policy.workflowType,
        },
      });
      if (this.workflowSwitch?.switched) {
        messages.push({
          role: "user",
          content: renderWorkflowSwitchContext(this.workflowSwitch),
        });
      }
    }

    const workflowResult = await this.runWorkflowExecutor(effectiveGoal, isResume, sessionId);
    this.workflowProposals = workflowResult.workflowProposals;
    this.workflowDebugAnalyses = workflowResult.workflowDebugAnalyses;
    this.workflowRefactorPlans = workflowResult.workflowRefactorPlans;
    this.workflowInternalPlans = workflowResult.workflowInternalPlans;
    for (const step of workflowResult.steps) {
      steps.push(step);
      this.options.onStep?.(step);
    }
    for (const modelContext of workflowResult.modelContexts) {
      messages.push({ role: "user", content: modelContext });
    }

    let modelTurns = 0;
    while (modelTurns < this.budget.maxModelTurns) {
      const runtimeExhausted = this.budgetManager.findRuntimeExhaustion();
      if (runtimeExhausted) {
        return await this.finishRun({
          answer: this.buildPartialAnswer(steps, runtimeExhausted, effectiveGoal),
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
      const modelStart = Date.now();
      let response: LoopChatResponse;
      try {
        assertWithinCostBudget(
          sumModelTurnCost(this.modelTurnMetrics.map((m) => m.costUsd)),
          this.options.maxCostUsdPerRun,
        );
        response = await this.options.chat(
          { messages, temperature: 0.2, onToken: this.options.onToken },
          {
            sensitive: this.options.sensitive,
            taskType: this.options.taskType,
            spentCostUsd: sumModelTurnCost(this.modelTurnMetrics.map((m) => m.costUsd)),
            maxCostUsd: this.options.maxCostUsdPerRun,
          },
        );
        if (!this.runRoutingMeta && response.routingMeta) {
          this.runRoutingMeta = response.routingMeta;
        }
        this.recordModelTurn({
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
          sumModelTurnCost(this.modelTurnMetrics.map((m) => m.costUsd)),
          this.options.maxCostUsdPerRun,
        );
      } catch (error) {
        this.recordModelTurn({
          iteration,
          success: false,
          latencyMs: Date.now() - modelStart,
          error: String(error),
        });
        throw error;
      }
      messages.push({ role: "assistant", content: response.content });
      if (ctx && sessionId) {
        ctx.saveAssistantMessage(sessionId, response.content);
      }

      const action = parseAction(response.content);
      if (!action) {
        this.writeAgentDecisionTrace({
          iteration,
          action: "parse_error",
          rawPreview: redactPreview(response.content, 300),
        });
        messages.push({
          role: "user",
          content: '上一条不是合法的 JSON。请只输出一个 JSON 对象：{"action":"tool",...} 或 {"action":"final","answer":"..."}。',
        });
        continue;
      }

      if (action.action === "final") {
        this.writeAgentDecisionTrace({
          iteration,
          action: "final",
          answerLength: action.answer.length,
        });
        return await this.finishRun({
          answer: action.answer,
          steps,
          iterations: iteration,
          reachedLimit: false,
          consumedNotifications,
          sessionId,
          userMessage: effectiveGoal,
        });
      }

      // 工具调用
      const toolCallId = this.makeToolCallId(iteration, action.tool);
      this.writeAgentDecisionTrace({
        iteration,
        action: "tool",
        tool: action.tool,
        toolCallId,
        thought: action.thought,
        inputPreview: redactPreview(action.input ?? {}, 500),
      });
      const tool = this.options.registry.get(action.tool);
      const toolBudgetExhausted = this.budgetManager.findToolExhaustion({
        toolPermission: tool?.permission,
        permissionAllowed: tool ? this.allowed.includes(tool.permission) : false,
        steps,
      });
      if (toolBudgetExhausted) {
        const step = this.buildBudgetBlockedStep(action, iteration, toolBudgetExhausted, toolCallId);
        steps.push(step);
        this.options.onStep?.(step);
        return await this.finishRun({
          answer: this.buildPartialAnswer(steps, toolBudgetExhausted, effectiveGoal),
          steps,
          iterations: modelTurns,
          reachedLimit: true,
          budgetExhausted: toolBudgetExhausted,
          consumedNotifications,
          sessionId,
          userMessage: effectiveGoal,
        });
      }
      const step = await this.runToolAction(action, iteration, toolCallId, {
        steps,
        goal: effectiveGoal,
      });
      steps.push(step);
      this.options.onStep?.(step);
      this.recordToolStepMessages({
        messages,
        step,
        steps,
        goal: effectiveGoal,
        sessionId,
      });
      const autoVerificationStep = await this.runEditAutoVerification(step, steps, iteration, effectiveGoal);
      if (autoVerificationStep) {
        steps.push(autoVerificationStep);
        this.options.onStep?.(autoVerificationStep);
        this.recordToolStepMessages({
          messages,
          step: autoVerificationStep,
          steps,
          goal: effectiveGoal,
          sessionId,
        });
      }
      injectNotifications();

      const postToolRuntimeExhausted = this.budgetManager.findRuntimeExhaustion();
      if (postToolRuntimeExhausted) {
        return await this.finishRun({
          answer: this.buildPartialAnswer(steps, postToolRuntimeExhausted, effectiveGoal),
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

    return await this.finishRun({
      answer: this.buildPartialAnswer(steps, "maxModelTurns", effectiveGoal),
      steps,
      iterations: modelTurns,
      reachedLimit: true,
      budgetExhausted: "maxModelTurns",
      consumedNotifications,
      sessionId,
      userMessage: effectiveGoal,
    });
  }

  private async finishRun(input: {
    answer: string;
    steps: AgentToolStep[];
    iterations: number;
    reachedLimit: boolean;
    budgetExhausted?: RunBudgetKey;
    consumedNotifications: AgentNotification[];
    sessionId?: string;
    userMessage: string;
  }): Promise<AgentRunResult> {
    const isResume = Boolean(this.options.resumeState);
    this.writeAgentStepPlanTrace(input.steps);
    const ctx = this.options.contextManager;
    let compressed = false;
    if (ctx && input.sessionId) {
      const result = await ctx.finalizeTurn(input.sessionId, input.userMessage);
      compressed = result.compressed !== null;
    }
    const executionMeta = this.buildExecutionMeta({
      steps: input.steps,
      iterations: input.iterations,
      stopReason: input.reachedLimit ? "budget_exhausted" : "completed",
      budgetExhausted: input.budgetExhausted,
      goal: input.userMessage,
    });
    this.writeRunUsageSummary(input.steps, executionMeta);

    if (
      input.sessionId &&
      !isResume &&
      this.policy.intent &&
      this.policy.workflowType
    ) {
      defaultWorkflowSessionStore.set({
        sessionId: input.sessionId,
        intent: this.policy.intent,
        workflowType: this.policy.workflowType,
        workflowTaskState: executionMeta.workflowTaskState,
        runId: this.options.runId,
        updatedAt: new Date().toISOString(),
      });
    }

    if (this.options.runStateStore && this.options.runId) {
      if (input.reachedLimit) {
        const state = buildRunStateFromAgentRun({
          runId: this.options.runId,
          goal: input.userMessage,
          mode: this.policy.mode,
          sessionId: input.sessionId,
          taskId: this.options.taskId,
          steps: input.steps,
          executionMeta,
          projectIndexStats: this.options.projectIndex
            ? (() => {
                const stats = this.options.projectIndex!.getStats("default", this.options.workspaceRoot);
                return { fileCount: stats.fileCount, symbolCount: stats.symbolCount };
              })()
            : undefined,
        });
        if (state) this.options.runStateStore.save(state);
      } else {
        this.options.runStateStore.markCompleted(this.options.runId);
      }
    }

    return {
      answer: input.answer,
      steps: input.steps,
      iterations: input.iterations,
      reachedLimit: input.reachedLimit,
      executionMeta,
      routerDecision: this.runRoutingMeta?.routerDecision,
      promptStrategy: this.runRoutingMeta?.promptStrategy,
      notifications: input.consumedNotifications.length
        ? input.consumedNotifications
        : undefined,
      sessionId: input.sessionId,
      compressed: compressed || undefined,
    };
  }

  private drainNotifications(): AgentNotification[] {
    return this.options.notificationQueue?.drain() ?? [];
  }

  private runWorkflowExecutor(userMessage: string, isResume: boolean, sessionId?: string) {
    return new WorkflowExecutor({
      registry: this.options.registry,
      workspaceRoot: this.options.workspaceRoot,
      allowedPermissions: this.allowed,
      budget: this.budget,
      budgetManager: this.budgetManager,
      policy: this.policy,
      trace: this.options.trace,
      contextManager: this.options.contextManager,
      sessionId,
      taskId: this.options.taskId,
      requestId: this.options.requestId ?? this.options.runId,
    }).executeBeforeModel({
      goal: userMessage,
      isResume,
      resumeState: this.options.resumeState,
    });
  }

  private buildEditExecutionContext(step: AgentToolStep, goal: string): string | undefined {
    return new EditExecutionWorkflow()
      .run({
        goal,
        intent: this.policy.intent,
        step,
      })?.modelContext;
  }

  private buildEditVerificationContext(
    steps: AgentToolStep[],
    currentStep: AgentToolStep,
    goal: string,
  ): string | undefined {
    return new EditVerificationWorkflow()
      .run({
        goal,
        intent: this.policy.intent,
        steps,
        currentStep,
      })?.modelContext;
  }

  private buildWorkflowCorrectionContext(
    steps: AgentToolStep[],
    currentStep: AgentToolStep,
    goal: string,
  ): string | undefined {
    return new WorkflowCorrectionWorkflow()
      .run({
        goal,
        intent: this.policy.intent,
        steps,
        currentStep,
      })?.modelContext;
  }

  private async runEditAutoVerification(
    writeStep: AgentToolStep,
    steps: AgentToolStep[],
    iteration: number,
    goal: string,
  ): Promise<AgentToolStep | undefined> {
    const planned = new EditAutoVerificationWorkflow().run({
      intent: this.policy.intent,
      step: writeStep,
    });
    if (!planned) return undefined;

    const action: ToolAction = {
      action: "tool",
      tool: planned.tool,
      input: planned.input,
      thought: planned.thought,
    };
    const tool = this.options.registry.get(action.tool);
    const budgetExhausted = this.budgetManager.findToolExhaustion({
      toolPermission: tool?.permission,
      permissionAllowed: tool ? this.allowed.includes(tool.permission) : false,
      steps,
    });
    const toolCallId = this.makeToolCallId(iteration, `${action.tool}:auto-verify`);
    if (budgetExhausted) {
      return this.buildBudgetBlockedStep(action, iteration, budgetExhausted, toolCallId);
    }
    this.writeAgentDecisionTrace({
      iteration,
      action: "tool",
      tool: action.tool,
      toolCallId,
      thought: action.thought,
      inputPreview: redactPreview(action.input ?? {}, 500),
    });
    return await this.runToolAction(action, iteration, toolCallId, { steps, goal });
  }

  private buildWritePhaseBlockedContext(goal: string, reason: string): string | undefined {
    const intent = this.policy.intent;
    if (!intent) return undefined;
    if (intent === "edit" || intent === "generate_file" || intent === "refactor") {
      return new EditWriteWorkflow().renderBlockedContext(goal, intent, reason);
    }
    if (intent === "debug") {
      return new DebugFixWorkflow().renderBlockedContext(goal, reason);
    }
    return undefined;
  }

  private recordToolStepMessages(input: {
    messages: ChatMessage[];
    step: AgentToolStep;
    steps: AgentToolStep[];
    goal: string;
    sessionId?: string;
  }): void {
    const toolText = this.renderToolResult(input.step);
    input.messages.push({ role: "user", content: toolText });
    if (input.step.workflowPhaseBlocked) {
      const blockedContext = this.buildWritePhaseBlockedContext(
        input.goal,
        input.step.error ?? "workflow write gate blocked",
      );
      if (blockedContext) {
        input.messages.push({ role: "user", content: blockedContext });
      }
    }
    if (this.pendingWritePhaseContext && input.step.ok) {
      const writePhaseContext = this.pendingWritePhaseContext;
      this.pendingWritePhaseContext = undefined;
      input.messages.push({ role: "user", content: writePhaseContext });
      if (input.sessionId && this.options.contextManager) {
        this.options.contextManager.saveToolMessage(input.sessionId, writePhaseContext);
      }
    }
    const editExecutionContext = this.buildEditExecutionContext(input.step, input.goal);
    if (editExecutionContext) {
      input.messages.push({ role: "user", content: editExecutionContext });
    }
    const editVerificationContext = this.buildEditVerificationContext(input.steps, input.step, input.goal);
    if (editVerificationContext) {
      input.messages.push({ role: "user", content: editVerificationContext });
    }
    const workflowCorrectionContext = this.buildWorkflowCorrectionContext(input.steps, input.step, input.goal);
    if (workflowCorrectionContext) {
      input.messages.push({ role: "user", content: workflowCorrectionContext });
    }
    const ctx = this.options.contextManager;
    if (ctx && input.sessionId) {
      ctx.saveToolMessage(input.sessionId, toolText);
      if (input.step.workflowPhaseBlocked) {
        const blockedContext = this.buildWritePhaseBlockedContext(
          input.goal,
          input.step.error ?? "workflow write gate blocked",
        );
        if (blockedContext) ctx.saveToolMessage(input.sessionId, blockedContext);
      }
      if (editExecutionContext) {
        ctx.saveToolMessage(input.sessionId, editExecutionContext);
      }
      if (editVerificationContext) {
        ctx.saveToolMessage(input.sessionId, editVerificationContext);
      }
      if (workflowCorrectionContext) {
        ctx.saveToolMessage(input.sessionId, workflowCorrectionContext);
      }
    }
  }

  private async runToolAction(
    action: ToolAction,
    iteration: number,
    toolCallId: string,
    ctx: { steps: AgentToolStep[]; goal: string },
  ): Promise<AgentToolStep> {
    const base: AgentToolStep = {
      iteration,
      toolCallId,
      tool: action.tool,
      input: action.input ?? {},
      thought: action.thought,
      ok: false,
    };

    const tool = this.options.registry.get(action.tool);
    if (!tool) {
      return { ...base, error: `未知工具：${action.tool}` };
    }
    const withPermission = { ...base, permission: tool.permission };

    const writeGate = assessWorkflowWriteGate({
      intent: this.policy.intent ?? "answer",
      goal: ctx.goal,
      tool: action.tool,
      steps: ctx.steps,
      hasProposal: this.workflowProposals.length > 0,
      hasDebugAnalysis: this.workflowDebugAnalyses.length > 0,
      hasRefactorPlan: this.workflowRefactorPlans.length > 0,
    });
    if (writeGate.blocked) {
      const reason = writeGate.reason ?? "workflow write gate blocked";
      return {
        ...withPermission,
        blocked: true,
        workflowPhaseBlocked: true,
        error: reason,
      };
    }
    if (
      !writeGate.blocked &&
      writeGate.priorWrites === 0 &&
      (action.tool === "write_file" || action.tool === "apply_patch")
    ) {
      const editWrite = new EditWriteWorkflow().run({
        goal: ctx.goal,
        intent: this.policy.intent ?? "answer",
        permissionPolicy: this.policy.permissionPolicy,
        gate: writeGate,
        tool: action.tool,
      });
      if (editWrite) {
        this.workflowWritePhases.push(editWrite.record);
        this.pendingWritePhaseContext = editWrite.modelContext;
      }
      const debugFix = new DebugFixWorkflow().run({
        goal: ctx.goal,
        intent: this.policy.intent ?? "answer",
        permissionPolicy: this.policy.permissionPolicy,
        gate: writeGate,
        tool: action.tool,
      });
      if (debugFix) {
        this.workflowDebugFixes.push(debugFix.record);
        this.pendingWritePhaseContext = debugFix.modelContext;
      }
    }

    const permissionDecision = evaluatePermissionGuard({
      intent: this.policy.intent,
      permissionPolicy: this.policy.permissionPolicy,
      toolName: tool.name,
      permission: tool.permission,
      input: action.input ?? {},
      allowedPermissions: this.allowed,
    });

    if (permissionDecision.decision === "deny") {
      return {
        ...withPermission,
        blocked: true,
        error: permissionDecision.reason ?? permissionDecision.risk.reasons[0],
        risk: permissionDecision.risk,
        confirmationRequest: permissionDecision.confirmationRequest,
      };
    }

    // 副作用/高风险工具：需要确认时阻塞（在非交互的循环里更安全）。
    if (permissionDecision.decision === "needsConfirmation") {
      return {
        ...withPermission,
        blocked: true,
        error:
          permissionDecision.reason ??
          `工具「${tool.name}」需要确认（权限 ${tool.permission}）。未开启自动确认，已跳过。`,
        risk: permissionDecision.risk,
        confirmationRequest: permissionDecision.confirmationRequest,
      };
    }
    this.options.trace?.write({
      type: "agent_tool",
      tool: action.tool,
      iteration,
      toolCallId,
      runId: this.options.runId,
      sessionId: this.options.sessionId,
      taskId: this.options.taskId,
    });
    const result = await this.options.registry.run(action.tool, action.input ?? {}, {
      workspaceRoot: this.options.workspaceRoot,
      allowedPermissions: this.allowed,
      taskId: this.options.taskId,
      sessionId: this.options.sessionId,
      requestId: this.options.requestId ?? this.options.runId,
      toolCallId,
    });

    if (result.ok) {
      const layers = buildToolResultLayers(action.tool, result.output, {
        compact: this.options.contextManager
          ? (t, out) => this.options.contextManager!.compactToolOutput(t, out)
          : undefined,
      });
      this.options.trace?.write({
        type: "agent_tool",
        tool: action.tool,
        iteration,
        toolCallId,
        runId: this.options.runId,
        sessionId: this.options.sessionId,
        taskId: this.options.taskId,
        status: "ok",
        rawJsonLength: layers.rawJsonLength,
        modelJsonLength: layers.modelJsonLength,
        userDisplay: layers.userDisplay,
        rawOutput: layers.raw,
      });
      return {
        ...withPermission,
        ok: true,
        output: layers.modelVisible,
        resultLayers: layers,
        durationMs: result.durationMs,
        toolCallId: result.toolCallId,
      };
    }
    return {
      ...withPermission,
      error: `[${result.code}] ${result.error}`,
      durationMs: result.durationMs,
      toolCallId: result.toolCallId,
      risk: result.ok ? undefined : result.risk,
    };
  }

  private buildBudgetBlockedStep(
    action: ToolAction,
    iteration: number,
    budgetExhausted: RunBudgetKey,
    toolCallId?: string,
  ): AgentToolStep {
    const tool = this.options.registry.get(action.tool);
    return {
      iteration,
      toolCallId,
      tool: action.tool,
      input: action.input ?? {},
      permission: tool?.permission,
      thought: action.thought,
      ok: false,
      blocked: true,
      error: `运行预算已耗尽：${budgetExhausted}`,
    };
  }

  private renderToolResult(step: AgentToolStep): string {
    if (step.blocked) {
      return `工具「${step.tool}」未执行：${step.error}。请改用其它只读工具，或直接给出 final 答案。`;
    }
    if (!step.ok) {
      if (step.error?.startsWith("未知工具：")) {
        return [
          `工具「${step.tool}」执行失败：${step.error}。`,
          "这不是可用工具列表中的工具名；请只从系统提示的可用工具列表选择真实工具。",
          "内部流程名、编排类名或子 Agent 控制器不能作为 tool 字段调用。",
          "如果已经可以回答，请直接输出 final；如果还需要信息，请改用 project_scan、locate_relevant_files、context_pack、read_file 等真实工具。",
        ].join("");
      }
      return `工具「${step.tool}」执行失败：${step.error}。请据此调整下一步。`;
    }
    const compacted = step.resultLayers?.modelVisible ?? step.output;
    const wrapped = wrapUntrustedToolOutput(step.tool, compacted);
    const body = clipModelToolJson(wrapped);
    return `工具「${step.tool}」执行结果（JSON）：\n${body}`;
  }

  private buildSystemPrompt(extra?: string): string {
    const specs = this.options.registry
      .list()
      .filter((t) => this.allowed.includes(t.permission))
      .map((t) => {
        const side = t.hasSideEffect ? " [副作用]" : "";
        return `- ${t.name}(${t.inputHint ?? ""}) [权限:${t.permission}]${side}：${t.description}`;
      })
      .join("\n");

    return [
      "你是一个本地优先的编程助手，可以使用工具读取/搜索/修改工作区文件、执行命令来完成用户任务。",
      "",
      "可用工具：",
      specs,
      "",
      "严格遵守以下协议：",
      '1. 每次回复必须且只能输出一个 JSON 对象，禁止输出 JSON 以外的任何文字或 Markdown 代码围栏。',
      '2. 需要使用工具时输出：{"action":"tool","tool":"工具名","input":{参数},"thought":"简述原因"}',
      '3. 已能回答用户时输出：{"action":"final","answer":"给用户的最终中文回答"}',
      "4. 一次只能调用一个工具；根据工具返回结果再决定下一步。",
      "5. 不要臆测文件内容或命令输出，先用工具查看再下结论。",
      "6. tool 字段只能填写上方“可用工具”列表中逐字出现的工具名；不要调用内部流程名、编排类名或子 Agent 控制器。",
      "7. 需要查找相关文件时，优先使用 project_scan / symbol_search / locate_relevant_files / context_pack；写入文件后可用 project_index_update 增量刷新索引；避免连续用 list_files、search_text、read_file 逐个试探。",
      "8. 已知类名/函数名时优先 symbol_search；locate_relevant_files 已返回 primaryFiles 时，优先用 context_pack 打包这些文件，再分析或修改。",
      this.policy.systemHint,
      extra ? `\n补充要求：${extra}` : "",
    ].join("\n");
  }

  private buildExecutionMeta(input: {
    steps: AgentToolStep[];
    iterations: number;
    stopReason: AgentStopReason;
    budgetExhausted?: RunBudgetKey;
    goal: string;
  }): AgentExecutionMeta {
    const usage = this.budgetManager.buildUsage(input.steps, input.iterations);
    const needsMoreBudget = input.stopReason === "budget_exhausted";
    const location = this.buildLocationMeta(input.steps);
    const workflowDiffs = this.buildWorkflowDiffs(input.steps);
    const workflowVerifications = this.buildWorkflowVerifications(input.steps);
    const workflowCorrections = this.buildWorkflowCorrections(input.steps);
    const workflowState = buildWorkflowState({
      intent: this.policy.intent,
      steps: input.steps,
      hasProposal: this.workflowProposals.length > 0,
      hasDebugAnalysis: this.workflowDebugAnalyses.length > 0,
      hasRefactorPlan: this.workflowRefactorPlans.length > 0,
      maxCorrectionAttempts: MAX_WORKFLOW_CORRECTION_ATTEMPTS,
    });
    const workflowTaskState = resolveWorkflowTaskState({
      stopReason: input.stopReason,
      steps: input.steps,
      hasPlanningPhase: hasPlanningPhaseArtifacts({
        workflowInternalPlans: this.workflowInternalPlans,
        workflowProposals: this.workflowProposals,
        workflowDebugAnalyses: this.workflowDebugAnalyses,
        workflowRefactorPlans: this.workflowRefactorPlans,
      }),
    });
    const base: AgentExecutionMeta = {
      mode: this.policy.mode,
      modeSource: this.policy.modeSource,
      intent: this.policy.intent,
      workflowType: this.policy.workflowType,
      permissionPolicy: this.policy.permissionPolicy,
      permissionPolicySource: this.policy.permissionPolicySource,
      workflowProposals: this.workflowProposals.length ? this.workflowProposals : undefined,
      workflowDebugAnalyses: this.workflowDebugAnalyses.length ? this.workflowDebugAnalyses : undefined,
      workflowRefactorPlans: this.workflowRefactorPlans.length ? this.workflowRefactorPlans : undefined,
      workflowInternalPlans: this.workflowInternalPlans.length ? this.workflowInternalPlans : undefined,
      workflowTaskState,
      workflowSwitch: this.workflowSwitch,
      workflowState,
      workflowDiffs: workflowDiffs.length ? workflowDiffs : undefined,
      workflowVerifications: workflowVerifications.length ? workflowVerifications : undefined,
      workflowCorrections: workflowCorrections.length ? workflowCorrections : undefined,
      workflowWritePhases: this.workflowWritePhases.length ? this.workflowWritePhases : undefined,
      workflowDebugFixes: this.workflowDebugFixes.length ? this.workflowDebugFixes : undefined,
      budget: this.budget,
      usage,
      budgetExhausted: input.budgetExhausted,
      usedIterations: input.iterations,
      usedModelTurns: input.iterations,
      usedToolCalls: usage.toolCalls,
      usedReadCalls: usage.readCalls,
      usedWriteCalls: usage.writeCalls,
      usedShellCalls: usage.shellCalls,
      stopReason: input.stopReason,
      needsMoreBudget,
      location,
      suggestedBudget: needsMoreBudget && input.budgetExhausted
        ? this.budgetManager.buildSuggestedBudget(input.budgetExhausted)
        : undefined,
    };
    if (!needsMoreBudget || !input.budgetExhausted) return base;
    return this.finalizer.enrichExecutionMeta(base, {
      steps: input.steps,
      budgetExhausted: input.budgetExhausted,
      budgetManager: this.budgetManager,
      mode: this.policy.mode,
      goal: input.goal,
      location,
    });
  }

  private buildPartialAnswer(
    steps: AgentToolStep[],
    budgetExhausted: RunBudgetKey,
    goal: string,
  ): string {
    return this.finalizer.buildPartialAnswer({
      steps,
      budgetExhausted,
      budgetManager: this.budgetManager,
      mode: this.policy.mode,
      goal,
      location: this.buildLocationMeta(steps),
    });
  }

  private buildWorkflowDiffs(steps: AgentToolStep[]): AgentWorkflowDiffRecord[] {
    return steps
      .filter((step) => step.ok && (step.tool === "write_file" || step.tool === "apply_patch"))
      .map((step) => {
        const raw = asRecord(step.resultLayers?.raw) ?? asRecord(step.output) ?? {};
        const diff = typeof raw.diff === "string" ? truncateWorkflowDiff(raw.diff) : undefined;
        return {
          toolCallId: step.toolCallId,
          tool: step.tool as "write_file" | "apply_patch",
          path: readString(raw.path),
          changeId: readString(raw.changeId),
          beforeHash: readString(raw.beforeHash),
          afterHash: readString(raw.afterHash),
          diff: diff?.diff,
          diffTruncated: diff?.truncated ?? false,
        };
      });
  }

  private buildWorkflowVerifications(steps: AgentToolStep[]): AgentWorkflowVerificationRecord[] {
    return new EditVerificationWorkflow().collect(this.policy.intent, steps);
  }

  private buildWorkflowCorrections(steps: AgentToolStep[]): AgentWorkflowCorrectionRecord[] {
    return new WorkflowCorrectionWorkflow().collect(this.policy.intent, steps);
  }

  private buildLocationMeta(steps: AgentToolStep[]): LocationExecutionMeta | undefined {
    const locationTools = new Set(["project_scan", "project_index_update", "symbol_search", "locate_relevant_files", "context_pack"]);
    const locationSteps = steps.filter((s) => locationTools.has(s.tool));
    const directSearchCalls = steps.filter((s) => s.tool === "search_text").length;
    const directListCalls = steps.filter((s) => s.tool === "list_files").length;
    const directReadCalls = steps.filter((s) => s.tool === "read_file").length;
    if (!locationSteps.length && !directSearchCalls && !directListCalls && !directReadCalls) return undefined;

    const locatedFiles = new Set<string>();
    const candidateFiles = new Set<string>();
    let usedSearchCalls = directSearchCalls;
    let usedListCalls = directListCalls;
    let usedReadForLocationCalls = directReadCalls;
    let stopReason: string | undefined;
    let needsContinue = false;
    let confidence: number | undefined;
    let suggestedAction: "continue_locating" | undefined;
    let exploration: {
      duplicateCount: number;
      newInformationCount: number;
      informationGain: number;
      lowYieldLoop: boolean;
    } | undefined;

    for (const step of locationSteps) {
      const output = step.output as Record<string, unknown> | undefined;
      if (!output) continue;
      const stats = output.locateStats as Record<string, unknown> | undefined;
      usedSearchCalls += readNumber(stats?.usedSearchCalls);
      usedListCalls += readNumber(stats?.usedListCalls);
      usedReadForLocationCalls += readNumber(stats?.usedReadForLocationCalls);
      stopReason = typeof output.stopReason === "string" ? output.stopReason : stopReason;
      needsContinue = needsContinue || output.needsMoreSearch === true || output.needsContinue === true;
      if (output.suggestedAction === "continue_locating") {
        suggestedAction = "continue_locating";
      }
      confidence = Math.max(confidence ?? 0, readNumber(output.confidence));

      const progress = output.explorationProgress as Record<string, unknown> | undefined;
      if (progress) {
        exploration = {
          duplicateCount: readNumber(progress.duplicateCount),
          newInformationCount: readNumber(progress.newInformationCount),
          informationGain: readNumber(progress.informationGain),
          lowYieldLoop: progress.lowYieldLoop === true,
        };
      }

      for (const item of readPathItems(output.primaryFiles)) locatedFiles.add(item);
      for (const item of readPathItems(output.files)) locatedFiles.add(item);
      for (const item of readPathItems(output.candidateFiles)) candidateFiles.add(item);
      for (const item of readPathItems(output.importantFiles)) candidateFiles.add(item);
    }

    return {
      usedLocateSteps: locationSteps.length,
      usedSearchCalls,
      usedListCalls,
      usedReadForLocationCalls,
      locatedFiles: [...locatedFiles].slice(0, 30),
      candidateFiles: [...candidateFiles].filter((p) => !locatedFiles.has(p)).slice(0, 30),
      stopReason,
      needsContinue,
      confidence,
      exploration,
      suggestedAction: needsContinue ? (suggestedAction ?? "continue_locating") : undefined,
    };
  }

  private writeAgentDecisionTrace(event: {
    iteration: number;
    action: "tool" | "final" | "parse_error";
    tool?: string;
    toolCallId?: string;
    thought?: string;
    inputPreview?: string;
    rawPreview?: string;
    answerLength?: number;
  }): void {
    this.options.trace?.write({
      type: "agent_decision",
      runId: this.options.runId,
      sessionId: this.options.sessionId,
      taskId: this.options.taskId,
      mode: this.policy.mode,
      ...event,
    });
  }

  private recordModelTurn(metric: AgentModelTurnMetric): void {
    this.modelTurnMetrics.push(metric);
    this.options.trace?.write({
      type: "agent_model_turn",
      runId: this.options.runId,
      sessionId: this.options.sessionId,
      taskId: this.options.taskId,
      mode: this.policy.mode,
      ...metric,
    });
  }

  private writeRunUsageSummary(steps: AgentToolStep[], executionMeta: AgentExecutionMeta): void {
    const inputTokens = sumOptional(this.modelTurnMetrics.map((m) => m.inputTokens));
    const outputTokens = sumOptional(this.modelTurnMetrics.map((m) => m.outputTokens));
    const costUsd = sumOptional(this.modelTurnMetrics.map((m) => m.costUsd));
    const modelLatencyMs = this.modelTurnMetrics.reduce((sum, m) => sum + m.latencyMs, 0);
    const modelErrors = this.modelTurnMetrics.filter((m) => !m.success);
    const failedTools = steps.filter((s) => !s.ok && !s.blocked);
    this.options.trace?.write({
      type: "run_usage_summary",
      runId: this.options.runId,
      sessionId: this.options.sessionId,
      taskId: this.options.taskId,
      mode: this.policy.mode,
      status: executionMeta.stopReason,
      reachedLimit: executionMeta.stopReason === "budget_exhausted",
      budget: executionMeta.budget,
      usage: executionMeta.usage,
      modelTurns: this.modelTurnMetrics.length,
      modelSuccesses: this.modelTurnMetrics.filter((m) => m.success).length,
      modelErrors: modelErrors.length,
      inputTokens,
      outputTokens,
      totalTokens:
        inputTokens === undefined && outputTokens === undefined
          ? undefined
          : (inputTokens ?? 0) + (outputTokens ?? 0),
      modelLatencyMs,
      costUsd,
      toolCalls: steps.length,
      failedTools: failedTools.length,
      blockedTools: steps.filter((s) => s.blocked).length,
      errors: [
        ...modelErrors.map((m) => m.error).filter((e): e is string => Boolean(e)),
        ...failedTools.map((s) => s.error).filter((e): e is string => Boolean(e)),
      ].slice(0, 10),
    });
  }

  private makeToolCallId(iteration: number, tool: string): string {
    const prefix = this.options.runId ?? this.options.requestId ?? this.options.taskId ?? "agent";
    return `${prefix}:iter-${iteration}:${tool}`;
  }

  private writeAgentStepPlanTrace(steps: AgentToolStep[]): void {
    if (!this.options.trace || !this.options.runId) return;
    const plan: AgentStepPlan = {
      runId: this.options.runId,
      mode: this.policy.mode === "implement" ? "execute" : this.policy.mode,
      ephemeral: true,
      createdAt: new Date().toISOString(),
      steps: steps.map((step, index) => ({
        id: step.iteration > 0 ? `iteration-${step.iteration}` : `workflow-${index + 1}`,
        intent: step.tool,
        tool: step.tool,
        reason: step.thought ?? `模型请求调用 ${step.tool}`,
        status: step.ok ? "done" : step.blocked ? "skipped" : "failed",
      })),
    };
    this.options.trace.write({
      type: "agent_step_plan",
      runId: plan.runId,
      mode: plan.mode,
      ephemeral: true,
      stepCount: plan.steps.length,
      steps: plan.steps,
      createdAt: plan.createdAt,
    });
  }
}

function sumOptional(values: Array<number | undefined>): number | undefined {
  let seen = false;
  let sum = 0;
  for (const value of values) {
    if (value === undefined) continue;
    seen = true;
    sum += value;
  }
  return seen ? Number(sum.toFixed(6)) : undefined;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function truncateWorkflowDiff(diff: string, maxChars = 20_000): { diff: string; truncated: boolean } {
  if (diff.length <= maxChars) return { diff, truncated: false };
  return { diff: `${diff.slice(0, maxChars)}\n... (workflow diff truncated)`, truncated: true };
}

function readPathItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string") {
        return (item as { path: string }).path;
      }
      return undefined;
    })
    .filter((item): item is string => Boolean(item));
}

/** 将安全点消费的通知格式化为可回灌给模型的用户消息。 */
export function renderNotifications(notes: AgentNotification[]): string {
  const lines = notes.map((n) => {
    const merged = readMergeCount(n.payload);
    const mergeHint = merged > 1 ? ` [合并×${merged}]` : "";
    return `- [${n.source}/${n.level}]${mergeHint} ${n.timestamp}: ${n.message}`;
  });
  return [
    "系统通知（后台任务等，已在安全点注入，请勿打断当前工具链）：",
    ...lines,
    "请酌情纳入下一步推理；若与当前任务无关可忽略。",
  ].join("\n");
}

/** 去掉思考块、围栏等噪声，便于从小模型输出中提取 JSON。 */
export function stripModelNoise(content: string): string {
  let s = content;
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/<redacted_reasoning>[\s\S]*?<\/redacted_reasoning>/gi, "");
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  return s.trim();
}

/** 从模型输出中提取第一个平衡的 JSON 对象并解析为动作。 */
export function parseAction(content: string): AgentAction | null {
  const obj = extractFirstJsonObject(stripModelNoise(content));
  if (!obj) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(obj);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (p.action === "final" && typeof p.answer === "string") {
    return { action: "final", answer: p.answer };
  }
  if (p.action === "tool" && typeof p.tool === "string") {
    return {
      action: "tool",
      tool: p.tool,
      input: (p.input as Record<string, unknown>) ?? {},
      thought: typeof p.thought === "string" ? p.thought : undefined,
    };
  }
  return null;
}

/** 扫描出首个平衡的 {...}（忽略字符串内的花括号）。 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
