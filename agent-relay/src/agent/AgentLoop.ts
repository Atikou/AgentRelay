import type { AgentNotification } from "../background/types.js";
import type { NotificationQueue } from "../background/NotificationQueue.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { ModelTaskType } from "../model/taskType.js";
import type { ChatMessage } from "../model/types.js";
import type { AgentPromptStrategySummary, AgentRouterDecisionSummary, AgentRoutingMeta } from "../model-router/agent-routing-summary.js";
import type { LoopChatFn, LoopChatResponse } from "../model-router/agent-chat-types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import { DISPATCH_SUBAGENT_TOOL_NAME } from "../tools/subagentTool.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import { redactPreview } from "../util/redact.js";
import { parseAction, type ToolAction } from "./AgentActionParser.js";
import { buildAgentSystemPrompt } from "./AgentSystemPromptBuilder.js";
import { buildWorkflowCapabilityHint } from "./AgentWorkflowCapabilityHint.js";
import {
  runAgentToolAction,
  type AgentToolActionRunContext,
} from "./AgentToolActionRunner.js";
import { renderAgentToolResultObservation } from "./AgentToolResultRenderer.js";
import { FailedActionMemory } from "./recovery/FailedActionMemory.js";
import { RunToolResultCache } from "./recovery/RunToolResultCache.js";
import {
  planSystemRecovery,
  renderCacheReuseContext,
} from "./recovery/SystemToolRecovery.js";
import { EditAutoVerificationWorkflow } from "./EditAutoVerificationWorkflow.js";
import {
  reconcileCapabilityBeforeTool as applyCapabilityEscalationBeforeTool,
} from "./AgentCapabilityEscalationOrchestrator.js";
import {
  executeAgentToolStepPipeline,
  type AgentToolStepPipelineContext,
} from "./AgentToolStepPipeline.js";
import {
  buildBudgetBlockedToolStep,
  buildPathBlockedToolStep,
  buildPermissionBlockedToolStep,
  buildWorkflowBlockedToolStep,
} from "./AgentToolStepBlockBuilder.js";
import { resolveEffectiveIntent } from "./capabilityEscalationRuntime.js";
import {
  buildEffectiveWorkflowContext,
  effectiveWorkflowRoute,
  type EffectiveWorkflowContext,
} from "./EffectiveWorkflowContext.js";
import type { PausedRunRuntimeState } from "./PausedRunStore.js";
import type { CapabilityEscalationRecord } from "./CapabilityEscalation.js";
import { defaultWorkflowRouter } from "./WorkflowRouter.js";
import { assessWorkflowToolAccess } from "./WorkflowCapability.js";
import type { CompletionGuardResult } from "./completion/CompletionFinalGuard.js";
import { ToolExecutionGateway } from "./ToolExecutionGateway.js";
import { EditProposalWorkflow } from "./EditProposalWorkflow.js";
import { WorkflowExecutor } from "./WorkflowExecutor.js";
import { orchestrateWorkflowWrite, type WorkflowWriteOrchestratorResult } from "./workflowWriteOrchestrator.js";
import { buildWorkflowFollowupContexts } from "./workflowFollowupContexts.js";
import { ToolRecoveryWorkflow } from "./ToolRecoveryWorkflow.js";
import { buildLocationMeta } from "./workflowExecutionMeta.js";
import type { AgentModelTurnEvent } from "./AgentModelTurn.js";
import type { AgentTimelineService } from "./timeline/AgentTimelineService.js";
import { type ToolPermission } from "../core/permissions.js";
import {
  resolveEffectivePermissions,
} from "../policy/PermissionPolicy.js";
import { evaluatePermissionGuard } from "../policy/PermissionGuard.js";
import {
  PathPolicy,
  type ToolPathPreparation,
} from "../policy/PathPolicy.js";
import type { WorkspaceGrantStore, WorkspaceScopePermission } from "../policy/WorkspaceScopeManager.js";
import {
  defaultPermissionRequestStore,
  type PermissionRequestStore,
} from "../policy/PermissionRequestStore.js";
import {
  defaultSessionPermissionGrants,
  type SessionPermissionGrants,
} from "../policy/SessionPermissionGrants.js";
import type {
  PermissionRequestPayload,
  ScopedApprovedPermissions,
} from "../policy/permissionRequestTypes.js";
import {
  defaultPlanHandoffStore,
  type PlanHandoffStore,
} from "../policy/PlanHandoffStore.js";
import type { PlanHandoffPayload } from "../policy/planHandoffTypes.js";
import type { AgentToolStep } from "./toolStep.js";
import { isSuccessfulToolStep } from "./toolStepOutcome.js";
import {
  defaultPausedRunStore,
  type PausedRunSnapshot,
  type PausedRunStore,
} from "./PausedRunStore.js";
import { BudgetManager } from "./BudgetManager.js";
import { defaultFinalizer } from "./Finalizer.js";
import { defaultRunPolicyManager } from "./RunPolicy.js";
import {
  type AgentExecutionMeta,
  type AgentRunMode,
  type AgentStopReason,
  type AgentWorkflowDebugAnalysis,
  type AgentWorkflowProposal,
  type AgentWorkflowDebugFix,
  type AgentWorkflowInternalPlan,
  type AgentWorkflowRefactorPlan,
  type AgentWorkflowSwitch,
  type AgentWorkflowWritePhase,
  type RunBudget,
  type RunBudgetKey,
  type RunPolicy,
} from "./RunPolicyTypes.js";
import type { RunStateStore } from "../orchestrator/RunStateStore.js";
import type { ProjectIndex } from "../context/ProjectIndex.js";
import type { RunState } from "../orchestrator/runStateTypes.js";
import {
  buildRunUsageSummaryTracePayload,
  type AgentModelTurnMetric,
} from "./AgentRunUsageSummary.js";
import { finalizeAgentRun, type AgentRunFinalizeContext } from "./AgentRunFinalizer.js";
import { buildAgentExecutionMeta } from "./AgentExecutionMetaBuilder.js";
import {
  buildPausedRunRuntimeState,
  buildPausedRunSnapshot,
  createJitPermissionRequestFromStep,
  restorePausedRunRuntimeState,
} from "./AgentPausedRunSnapshot.js";
import { bootstrapAgentRunSession } from "./AgentRunBootstrap.js";
import { runAgentReactLoop, type AgentReactLoopContext } from "./AgentReactLoopRunner.js";

export interface AgentRunResult {
  answer: string;
  steps: AgentToolStep[];
  iterations: number;
  /** 本轮运行预算耗尽时为 true。 */
  reachedLimit: boolean;
  /** 等待用户权限确认时为 true。 */
  awaitingPermission?: boolean;
  /** 等待计划交接批准时为 true。 */
  awaitingPlanHandoff?: boolean;
  /** 固定 JSON 权限申请（工具级 JIT）。 */
  permissionRequest?: PermissionRequestPayload;
  /** 计划→执行交接（与 permissionRequest 分离）。 */
  planHandoff?: PlanHandoffPayload;
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

export interface AgentLoopOptions {
  chat: LoopChatFn;
  registry: ToolRegistry;
  workspaceRoot: string;
  /** 暴露给模型/可执行的权限集，默认任务模式全集。 */
  allowedPermissions?: ToolPermission[];
  /** 项目级权限上限（来自 config.security.permissions）。 */
  projectAllowedPermissions?: ToolPermission[];
  /** 子 Agent toolPolicy 推导的权限上限（仅子 Agent 路径传入）。 */
  roleAllowedPermissions?: ToolPermission[];
  /** 当前子 Agent 派生深度（主 Agent 为 0）。 */
  subAgentDispatchDepth?: number;
  /** dispatch_subagent 最大派生深度；默认 1，不支持无限递归。 */
  maxSubAgentDispatchDepth?: number;
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
  /** 每轮模型调用开始/结束时的决策摘要（供 SSE 思考过程展示）。 */
  onModelTurn?: (turn: AgentModelTurnEvent) => void;
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
  projectId?: string;
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
  /** 取消信号；子 Agent 显式 cancel 时在各轮次安全点中断。 */
  signal?: AbortSignal;
  /** Activity Timeline：公开执行摘要（非模型 CoT）。 */
  timeline?: AgentTimelineService;
  /** 遇权限确认门时暂停 Run 并返回 permissionRequest（默认：未开启 autoConfirm 时）。 */
  pauseOnPermissionRequest?: boolean;
  /** 权限申请存储（HTTP 入口注入单例）。 */
  permissionRequestStore?: PermissionRequestStore;
  /** 计划交接存储（HTTP 入口注入单例）。 */
  planHandoffStore?: PlanHandoffStore;
  /** 会话级已批准作用域权限。 */
  sessionPermissionGrants?: SessionPermissionGrants;
  /** 本轮一次性已批准作用域权限。 */
  scopedGrants?: ScopedApprovedPermissions;
  /** 持久化多工作区授权。 */
  workspaceGrantStore?: WorkspaceGrantStore;
  /** 配置型只读/预授权工作区。 */
  workspaceConfigScopes?: Array<{
    id: string;
    rootPath: string;
    label?: string;
    permissions?: WorkspaceScopePermission[];
  }>;
  /** 暂停 Run 快照存储（HTTP 入口注入单例），用于权限暂停后的忠实续跑。 */
  pausedRunStore?: PausedRunStore;
  /** 恢复执行：从该快照忠实续跑同一段对话（执行被批准工具或按计划进入执行阶段）。 */
  pausedRun?: PausedRunSnapshot;
  /** 计划报告 analyze API：产出 final 后不冻结 planHandoff，直接返回完整 answer。 */
  skipPlanHandoff?: boolean;
  shellPolicy?: import("../policy/ShellPolicy.js").ShellPolicy;
  networkPolicy?: import("../policy/NetworkPolicy.js").NetworkPolicy;
}

/**
 * 基础 Agent 对话循环（M1）。
 *
 * 采用可移植的 ReAct 风格 JSON 协议：模型每轮只输出一个 JSON——要么请求调用一个工具，
 * 要么给出最终答案。工具经 ToolRegistry 执行（含校验/权限/风险/超时），结果回灌给模型继续推理。
 * 不依赖各后端的原生 function-calling，本地与远程模型均可用。
 */
export class AgentLoop {
  private readonly allowed: ToolPermission[];
  private readonly scopedGrants?: ScopedApprovedPermissions;
  private readonly permissionRequestStore: PermissionRequestStore;
  private readonly planHandoffStore: PlanHandoffStore;
  private readonly pausedRunStore: PausedRunStore;
  private readonly sessionPermissionGrants: SessionPermissionGrants;
  private readonly pauseOnPermissionRequest: boolean;
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
  private capabilityEscalations: CapabilityEscalationRecord[] = [];
  private reconciledWorkflowType?: import("./IntentTypes.js").AgentWorkflowType;
  private reconciledIntent?: import("./IntentTypes.js").AgentIntentType;
  private entryIntent?: import("./IntentTypes.js").AgentIntentType;
  private entryWorkflowType?: import("./IntentTypes.js").AgentWorkflowType;
  private pendingWritePhaseContext?: string;
  private readonly toolResultCache = new RunToolResultCache();
  private failedActionMemory: FailedActionMemory;

  private readonly toolGateway: ToolExecutionGateway;

  constructor(private readonly options: AgentLoopOptions) {
    this.toolGateway = new ToolExecutionGateway(options.registry);
    this.policy =
      options.policy ??
      defaultRunPolicyManager.resolve({
        requestedMode: options.mode,
        forceMode: options.mode != null,
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
      roleSource: options.roleAllowedPermissions ? "subagent.toolPolicy" : undefined,
      userGranted: options.allowedPermissions,
      userSource: "agent.allowedPermissions",
      strictUserGrant: options.allowedPermissions != null,
    });
    this.allowed = resolved.allowed;
    this.budgetManager = defaultRunPolicyManager.createBudgetManager(this.policy);
    this.failedActionMemory = new FailedActionMemory(this.policy.budget.maxRepeatedToolFailures);
    this.scopedGrants = options.scopedGrants;
    this.permissionRequestStore = options.permissionRequestStore ?? defaultPermissionRequestStore;
    this.planHandoffStore = options.planHandoffStore ?? defaultPlanHandoffStore;
    this.pausedRunStore = options.pausedRunStore ?? defaultPausedRunStore;
    this.sessionPermissionGrants = options.sessionPermissionGrants ?? defaultSessionPermissionGrants;
    this.pauseOnPermissionRequest =
      options.pauseOnPermissionRequest ?? options.autoConfirm !== true;
  }

  private resolveScopedGrants(): ScopedApprovedPermissions | undefined {
    const sessionId = this.options.sessionId;
    const sessionGrants = sessionId ? this.sessionPermissionGrants.get(sessionId) : undefined;
    if (!this.scopedGrants && !sessionGrants) return undefined;
    return {
      read_file: [...new Set([...(this.scopedGrants?.read_file ?? []), ...(sessionGrants?.read_file ?? [])])],
      write_file: [...new Set([...(this.scopedGrants?.write_file ?? []), ...(sessionGrants?.write_file ?? [])])],
      shell: [...new Set([...(this.scopedGrants?.shell ?? []), ...(sessionGrants?.shell ?? [])])],
      delete_file: [...new Set([...(this.scopedGrants?.delete_file ?? []), ...(sessionGrants?.delete_file ?? [])])],
      network: [...new Set([...(this.scopedGrants?.network ?? []), ...(sessionGrants?.network ?? [])])],
      dangerous: [...new Set([...(this.scopedGrants?.dangerous ?? []), ...(sessionGrants?.dangerous ?? [])])],
    };
  }

  private preparePathAccess(action: ToolAction): ToolPathPreparation | undefined {
    const policy = new PathPolicy({
      primaryRoot: this.options.workspaceRoot,
      grants: this.options.workspaceGrantStore,
      configScopes: this.options.workspaceConfigScopes,
    });
    return policy.prepareTool(action.tool, (action.input ?? {}) as Record<string, unknown>, {
      sessionId: this.options.sessionId,
      projectId: this.options.projectId,
      taskId: this.options.taskId,
      scopedGrants: this.resolveScopedGrants(),
    });
  }

  private buildPathBlockedStep(
    action: ToolAction,
    iteration: number,
    pathAccess: ToolPathPreparation,
    toolCallId?: string,
  ): AgentToolStep {
    const tool = this.options.registry.get(action.tool);
    return buildPathBlockedToolStep({
      action,
      iteration,
      toolCallId,
      toolPermission: tool?.permission,
      pathAccess,
      intent: this.getEffectiveIntent(),
      permissionPolicy: this.policy.permissionPolicy,
    });
  }

  private get budget(): RunBudget {
    return this.budgetManager.budget;
  }

  private restoreApprovedHandoffArtifacts(pausedRun: PausedRunSnapshot): void {
    if (!pausedRun.resumeMode || this.workflowProposals.length > 0) return;
    const result = new EditProposalWorkflow().run({
      goal: pausedRun.goal,
      intent: this.getEffectiveIntent(),
      permissionPolicy: this.policy.permissionPolicy,
      allowedPermissions: this.allowed,
    });
    if (result) {
      this.workflowProposals = [result.proposal];
    }
  }

  private assertNotCancelled(): void {
    const signal = this.options.signal;
    if (!signal?.aborted) return;
    throw signal.reason ?? new Error("子 Agent 已取消");
  }

  private resetRunState(): void {
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
    this.capabilityEscalations = [];
    this.reconciledWorkflowType = undefined;
    this.reconciledIntent = undefined;
    this.entryIntent = this.policy.intent;
    this.entryWorkflowType = this.policy.workflowType;
    this.pendingWritePhaseContext = undefined;
    this.toolResultCache.invalidateAll();
    this.failedActionMemory = new FailedActionMemory(this.policy.budget.maxRepeatedToolFailures);
  }

  private applyPlanHandoffSystemPrompt(messages: ChatMessage[], pausedRun: PausedRunSnapshot): void {
    if (!pausedRun.resumeMode) return;
    const handoffExecutionContext = [
      "内部运行态：用户已通过权限弹窗批准执行计划。",
      "这不是一条用户消息，不要复述、感谢或询问是否继续。",
      '下一条回复必须直接输出一个 ReAct JSON 对象：{"action":"tool",...} 或 {"action":"final","answer":"..."}。',
      "如果需要创建嵌套路径的新文件，调用 write_file 时必须使用 createDirs:true。",
    ].join("\n");
    const executionSystemPrompt = `${this.buildSystemPrompt(pausedRun.system)}\n\n${handoffExecutionContext}`;
    if (messages[0]?.role === "system") {
      messages[0] = { role: "system", content: executionSystemPrompt };
    } else {
      messages.unshift({ role: "system", content: executionSystemPrompt });
    }
  }

  private buildRunBootstrapContext() {
    return {
      contextManager: this.options.contextManager,
      timeline: this.options.timeline,
      runId: this.options.runId,
      policy: this.policy,
      getEffectiveIntent: () => this.getEffectiveIntent(),
      buildSystemPrompt: (extra?: string) => this.buildSystemPrompt(extra),
      drainNotifications: () => this.drainNotifications(),
      runWorkflowExecutor: (goal: string, isResume: boolean, sessionId?: string) =>
        this.runWorkflowExecutor(goal, isResume, sessionId),
      applyWorkflowResult: (result: Awaited<ReturnType<AgentLoop["runWorkflowExecutor"]>>) => {
        this.workflowProposals = result.workflowProposals;
        this.workflowDebugAnalyses = result.workflowDebugAnalyses;
        this.workflowRefactorPlans = result.workflowRefactorPlans;
        this.workflowInternalPlans = result.workflowInternalPlans;
      },
      setWorkflowSwitch: (value: AgentWorkflowSwitch | undefined) => {
        this.workflowSwitch = value;
      },
      getWorkflowProposals: () => this.workflowProposals,
      recordPreflightTools: (count: number) => this.budgetManager.recordPreflightTool(count),
      onWorkflowStep: this.options.onStep,
      resumePendingAction: (input: Parameters<AgentLoop["resumePendingAction"]>[0]) =>
        this.resumePendingAction(input),
      applyPlanHandoffSystemPrompt: (messages: ChatMessage[], pausedRun: PausedRunSnapshot) =>
        this.applyPlanHandoffSystemPrompt(messages, pausedRun),
    };
  }

  private buildReactLoopContext(session: {
    pausedRun?: PausedRunSnapshot;
  }): AgentReactLoopContext {
    return {
      chat: this.options.chat,
      signal: this.options.signal,
      sensitive: this.options.sensitive,
      taskType: this.options.taskType,
      maxCostUsdPerRun: this.options.maxCostUsdPerRun,
      maxModelTurns: this.budget.maxModelTurns,
      budgetManager: this.budgetManager,
      contextManager: this.options.contextManager,
      runId: this.options.runId,
      policy: this.policy,
      pausedRun: session.pausedRun,
      reconciledIntent: this.reconciledIntent,
      capabilityEscalations: this.capabilityEscalations,
      failedActionMemory: this.failedActionMemory,
      toolResultCache: this.toolResultCache,
      finalizer: this.finalizer,
      planHandoffStore: this.planHandoffStore,
      getEffectiveIntent: () => this.getEffectiveIntent(),
      getModelTurnMetrics: () => this.modelTurnMetrics,
      recordModelTurn: (metric) => this.recordModelTurn(metric),
      setRunRoutingMeta: (meta) => {
        this.runRoutingMeta = meta;
      },
      getRunRoutingMeta: () => this.runRoutingMeta,
      onModelTurn: this.options.onModelTurn,
      onStep: this.options.onStep,
      onToken: this.options.onToken,
      assertNotCancelled: () => this.assertNotCancelled(),
      isCancelledError: (err) => this.isCancelledError(err),
      makeToolCallId: (iteration, tool) => this.makeToolCallId(iteration, tool),
      writeAgentDecisionTrace: (input) => this.writeAgentDecisionTrace(input),
      shouldCreatePlanHandoff: () => this.shouldCreatePlanHandoff(),
      snapshotPausedRun: (input) => this.snapshotPausedRun(input),
      executeToolStep: (input) => this.executeToolStep(input),
      recordToolStepMessages: (input) => this.recordToolStepMessages(input),
      maybeRunSystemRecovery: (input) => this.maybeRunSystemRecovery(input),
      runEditAutoVerification: (step, steps, iteration, goal) =>
        this.runEditAutoVerification(step, steps, iteration, goal),
      buildPartialAnswer: (steps, budgetExhausted, goal) =>
        this.buildPartialAnswer(steps, budgetExhausted, goal),
      finishRun: (input) => this.finishRun(input),
    };
  }

  async run(userMessage: string, system?: string): Promise<AgentRunResult> {
    this.resetRunState();
    const pausedRun = this.options.pausedRun;
    if (pausedRun) {
      this.workflowProposals = [...(pausedRun.workflowProposals ?? [])];
      this.workflowDebugAnalyses = [...(pausedRun.workflowDebugAnalyses ?? [])];
      this.workflowRefactorPlans = [...(pausedRun.workflowRefactorPlans ?? [])];
      this.workflowInternalPlans = [...(pausedRun.workflowInternalPlans ?? [])];
      this.restoreRuntimeSnapshot(pausedRun.runtimeState);
      this.restoreApprovedHandoffArtifacts(pausedRun);
    }
    const isResume = Boolean(this.options.resumeState);
    const effectiveGoal = pausedRun
      ? pausedRun.goal
      : isResume
        ? this.options.resumeState!.goal
        : userMessage;
    const initialSessionId =
      pausedRun?.sessionId ?? this.options.resumeState?.sessionId ?? this.options.sessionId;
    const initialSteps: AgentToolStep[] = pausedRun
      ? [...pausedRun.steps]
      : isResume
        ? [...(this.options.resumeState?.completedToolSteps ?? [])]
        : [];
    let catchState = {
      steps: initialSteps,
      modelTurns: pausedRun?.modelTurns ?? 0,
      sessionId: initialSessionId,
      consumedNotifications: [] as AgentNotification[],
    };

    try {
      const boot = await bootstrapAgentRunSession(this.buildRunBootstrapContext(), {
        userMessage,
        system,
        effectiveGoal,
        isResume,
        pausedRun,
        initialSessionId,
        initialSteps,
        initialModelTurns: catchState.modelTurns,
      });
      catchState = {
        steps: boot.session.steps,
        modelTurns: boot.session.modelTurns,
        sessionId: boot.session.sessionId,
        consumedNotifications: boot.session.consumedNotifications,
      };
      if (boot.earlyResult) return boot.earlyResult;
      return await runAgentReactLoop(this.buildReactLoopContext(boot.session), boot.session);
    } catch (err) {
      if (this.isCancelledError(err)) {
        return await this.finishRun({
          answer: "",
          steps: catchState.steps,
          iterations: catchState.modelTurns,
          reachedLimit: false,
          stopReason: "user_cancelled",
          consumedNotifications: catchState.consumedNotifications,
          sessionId: catchState.sessionId,
          userMessage: effectiveGoal,
        });
      }
      throw err;
    }
  }

  private isCancelledError(err: unknown): boolean {
    const msg = String(err);
    if (msg.includes("运行已取消") || msg.includes("子 Agent 已取消")) return true;
    if (err instanceof Error && err.name === "AbortError") return true;
    const signal = this.options.signal;
    return signal?.aborted === true;
  }

  private buildRunFinalizeContext(): AgentRunFinalizeContext {
    return {
      isResume: Boolean(this.options.resumeState),
      runId: this.options.runId,
      taskId: this.options.taskId,
      policy: this.policy,
      entryIntent: this.entryIntent,
      entryWorkflowType: this.entryWorkflowType,
      reconciledIntent: this.reconciledIntent,
      reconciledWorkflowType: this.reconciledWorkflowType,
      getEffectiveIntent: () => this.getEffectiveIntent(),
      capabilityEscalations: this.capabilityEscalations,
      budgetManager: this.budgetManager,
      budget: this.budget,
      timeline: this.options.timeline,
      contextManager: this.options.contextManager,
      runStateStore: this.options.runStateStore,
      projectIndex: this.options.projectIndex,
      workspaceRoot: this.options.workspaceRoot,
      runRoutingMeta: this.runRoutingMeta,
      trace: this.options.trace,
      buildExecutionMeta: (input) => this.buildExecutionMeta(input),
      writeRunUsageSummary: (steps, executionMeta) =>
        this.writeRunUsageSummary(steps, executionMeta),
    };
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
    stopReason?: AgentStopReason;
    permissionRequest?: PermissionRequestPayload;
    planHandoff?: PlanHandoffPayload;
    awaitingPermission?: boolean;
    awaitingPlanHandoff?: boolean;
    completionGuard?: CompletionGuardResult;
    partialSummary?: string;
  }): Promise<AgentRunResult> {
    return finalizeAgentRun(this.buildRunFinalizeContext(), input);
  }

  private drainNotifications(): AgentNotification[] {
    const queue = this.options.notificationQueue;
    if (!queue) return [];
    // 按 runId 限定消费，避免并发运行互相截走对方的 run 级通知；兼容仅实现 drain 的 mock。
    if (typeof queue.drainForRun === "function") {
      return queue.drainForRun(this.options.runId);
    }
    return queue.drain();
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

  private async runEditAutoVerification(
    writeStep: AgentToolStep,
    steps: AgentToolStep[],
    iteration: number,
    goal: string,
  ): Promise<AgentToolStep | undefined> {
    const planned = new EditAutoVerificationWorkflow().run({
      intent: this.getEffectiveIntent(),
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
    const toolCallId = this.makeToolCallId(iteration, `${action.tool}:auto-verify`);
    const workflowRoute = effectiveWorkflowRoute(this.getEffectiveWorkflowContext());
    this.reconcileCapabilityBeforeTool({
      action,
      toolPermission: tool?.permission,
      workflowRoute,
      iteration,
    });
    const workflowBlock = assessWorkflowToolAccess({
      mode: this.policy.mode,
      workflowRoute,
      toolPermission: tool?.permission,
    });
    if (workflowBlock.blocked) {
      return this.buildWorkflowBlockedStep(action, iteration, workflowBlock, toolCallId);
    }
    if (tool) {
      const permissionDecision = evaluatePermissionGuard({
        intent: this.getEffectiveIntent(),
        permissionPolicy: this.policy.permissionPolicy,
        toolName: tool.name,
        permission: tool.permission,
        input: action.input ?? {},
        allowedPermissions: this.allowed,
        scopedGrants: this.resolveScopedGrants(),
        shellPolicy: this.options.shellPolicy,
        networkPolicy: this.options.networkPolicy,
      });
      if (permissionDecision.decision !== "allow") {
        return this.buildPermissionBlockedStep(
          action,
          iteration,
          permissionDecision.reason ?? "权限未允许",
          toolCallId,
          tool.permission,
        );
      }
    }
    const budgetExhausted = this.budgetManager.findToolExhaustion({
      toolPermission: tool?.permission,
      permissionAllowed: Boolean(tool),
      steps,
    });
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

  private recordToolStepMessages(input: {
    messages: ChatMessage[];
    step: AgentToolStep;
    steps: AgentToolStep[];
    goal: string;
    sessionId?: string;
  }): void {
    const toolText = renderAgentToolResultObservation(input.step, input.steps);
    input.messages.push({
      role: "tool",
      name: input.step.tool,
      toolCallId: input.step.toolCallId,
      content: toolText,
    });
    if (input.step.cached) {
      input.messages.push({
        role: "system",
        content: renderCacheReuseContext(
          input.step.tool,
          (input.step.input ?? {}) as Record<string, unknown>,
        ),
      });
    }
    const followups = buildWorkflowFollowupContexts({
      intent: this.getEffectiveIntent(),
      goal: input.goal,
      step: input.step,
      steps: input.steps,
      pendingWritePhaseContext: this.pendingWritePhaseContext,
    });
    this.pendingWritePhaseContext = followups.pendingWritePhaseContext;
    for (const extra of [
      followups.blockedContext,
      followups.toolRecoveryContext,
      followups.writePhaseContext,
      followups.editExecutionContext,
      followups.editVerificationContext,
      followups.workflowCorrectionContext,
    ]) {
      if (extra) input.messages.push({ role: "system", content: extra });
    }
    const ctx = this.options.contextManager;
    if (ctx && input.sessionId) {
      ctx.saveToolMessage(input.sessionId, toolText, this.options.runId, {
        outcomeClass: input.step.outcomeClass,
        outcomeKind: input.step.outcomeKind,
        toolCallId: input.step.toolCallId,
        ledgerBacked:
          input.step.outcomeClass === "observation_success" &&
          input.step.outcomeKind !== "not_found" &&
          input.step.outcomeKind !== "no_results",
      });
    }
  }

  private async maybeRunSystemRecovery(input: {
    step: AgentToolStep;
    messages: ChatMessage[];
    steps: AgentToolStep[];
    goal: string;
    sessionId?: string;
    iteration: number;
  }): Promise<void> {
    if (input.step.ok || input.step.blocked || input.step.cached || input.step.systemRecovery) return;
    if (!this.budgetManager.canRunRecovery()) return;
    const plan = planSystemRecovery(input.step, input.goal);
    if (!plan) return;

    input.messages.push({ role: "system", content: plan.preamble });
    for (const recovery of plan.actions) {
      if (!this.budgetManager.canRunRecovery()) break;
      this.budgetManager.recordRecoveryTurn();
      const action: ToolAction = {
        action: "tool",
        tool: recovery.tool,
        input: recovery.input,
        thought: recovery.reason,
      };
      const toolCallId = this.makeToolCallId(input.iteration, `recovery:${recovery.tool}`);
      const recoveryStep = await this.runToolAction(action, input.iteration, toolCallId, {
        steps: input.steps,
        goal: input.goal,
        isRecovery: true,
      });
      recoveryStep.systemRecovery = true;
      input.steps.push(recoveryStep);
      this.options.onStep?.(recoveryStep);
      this.recordToolStepMessages({
        messages: input.messages,
        step: recoveryStep,
        steps: input.steps,
        goal: input.goal,
        sessionId: input.sessionId,
      });
      if (recoveryStep.ok) break;
    }
  }

  private applyWorkflowWriteSideEffects(write?: WorkflowWriteOrchestratorResult): void {
    if (!write || write.writePhaseBlocked) return;
    if (write.writePhaseRecord) this.workflowWritePhases.push(write.writePhaseRecord);
    if (write.debugFixRecord) this.workflowDebugFixes.push(write.debugFixRecord);
    if (write.pendingWritePhaseContext) this.pendingWritePhaseContext = write.pendingWritePhaseContext;
  }

  private buildToolActionRunContext(): AgentToolActionRunContext {
    return {
      registry: this.options.registry,
      toolGateway: this.toolGateway,
      timeline: this.options.timeline,
      runId: this.options.runId,
      sessionId: this.options.sessionId,
      projectId: this.options.projectId,
      taskId: this.options.taskId,
      requestId: this.options.requestId,
      trace: this.options.trace,
      workspaceRoot: this.options.workspaceRoot,
      workspaceGrantStore: this.options.workspaceGrantStore,
      workspaceConfigScopes: this.options.workspaceConfigScopes,
      signal: this.options.signal,
      sensitive: this.options.sensitive,
      subAgentDispatchDepth: this.options.subAgentDispatchDepth,
      maxSubAgentDispatchDepth: this.options.maxSubAgentDispatchDepth,
      projectAllowedPermissions: this.options.projectAllowedPermissions,
      contextManager: this.options.contextManager,
      allowedPermissions: this.allowed,
      permissionPolicy: this.policy.permissionPolicy,
      reconciledWorkflowType: this.reconciledWorkflowType,
      policyWorkflowType: this.policy.workflowType,
      getIntent: () => this.getEffectiveIntent(),
      shellPolicy: this.options.shellPolicy,
      networkPolicy: this.options.networkPolicy,
      isToolExposed: (toolName) => this.isToolExposedToModel(toolName),
      preparePathAccess: (action) => this.preparePathAccess(action),
      resolveScopedGrants: () => this.resolveScopedGrants(),
      failedActionMemory: this.failedActionMemory,
      toolResultCache: this.toolResultCache,
      budgetManager: this.budgetManager,
      buildPathBlockedStep: (action, iteration, pathAccess, toolCallId) =>
        this.buildPathBlockedStep(action, iteration, pathAccess, toolCallId),
      workflowWriteOrchestration: ({ tool, steps, goal }) =>
        orchestrateWorkflowWrite({
          intent: this.getEffectiveIntent(),
          goal,
          permissionPolicy: this.policy.permissionPolicy,
          tool,
          steps,
          hasProposal: this.workflowProposals.length > 0,
          hasDebugAnalysis: this.workflowDebugAnalyses.length > 0,
          hasRefactorPlan: this.workflowRefactorPlans.length > 0,
        }),
    };
  }

  private async runToolAction(
    action: ToolAction,
    iteration: number,
    toolCallId: string,
    ctx: { steps: AgentToolStep[]; goal: string; isRecovery?: boolean; isPreflight?: boolean },
  ): Promise<AgentToolStep> {
    const result = await runAgentToolAction(this.buildToolActionRunContext(), {
      action,
      iteration,
      toolCallId,
      steps: ctx.steps,
      goal: ctx.goal,
      isRecovery: ctx.isRecovery,
      isPreflight: ctx.isPreflight,
    });
    this.applyWorkflowWriteSideEffects(result.workflowWrite);
    return result.step;
  }

  private buildBudgetBlockedStep(
    action: ToolAction,
    iteration: number,
    budgetExhausted: RunBudgetKey,
    toolCallId?: string,
  ): AgentToolStep {
    const tool = this.options.registry.get(action.tool);
    return buildBudgetBlockedToolStep({
      action,
      iteration,
      toolCallId,
      toolPermission: tool?.permission,
      budgetExhausted,
    });
  }

  private reconcileCapabilityBeforeTool(input: {
    action: ToolAction;
    toolPermission?: ToolPermission;
    workflowRoute: ReturnType<typeof defaultWorkflowRouter.routeIntent>;
    iteration: number;
    messages?: ChatMessage[];
  }): void {
    const result = applyCapabilityEscalationBeforeTool({
      action: input.action,
      toolPermission: input.toolPermission,
      workflowRoute: input.workflowRoute,
      iteration: input.iteration,
      messages: input.messages,
      capabilityEscalations: this.capabilityEscalations,
      budgetManager: this.budgetManager,
      permissionPolicy: this.policy.permissionPolicy,
      timeline: this.options.timeline,
      runId: this.options.runId,
    });
    if (result.reconciledIntent) this.reconciledIntent = result.reconciledIntent;
    if (result.reconciledWorkflowType) this.reconciledWorkflowType = result.reconciledWorkflowType;
  }

  private getEffectiveIntent(): import("./IntentTypes.js").AgentIntentType {
    return resolveEffectiveIntent(this.policy.intent, this.reconciledIntent);
  }

  private getEffectiveWorkflowContext(): EffectiveWorkflowContext {
    return buildEffectiveWorkflowContext({
      entryIntent: this.entryIntent ?? this.policy.intent,
      entryWorkflowType: this.entryWorkflowType ?? this.policy.workflowType,
      reconciledIntent: this.reconciledIntent,
      reconciledWorkflowType: this.reconciledWorkflowType,
      capabilityEscalations: this.capabilityEscalations,
    });
  }

  private buildRuntimeSnapshot(): PausedRunRuntimeState {
    return buildPausedRunRuntimeState({
      entryIntent: this.entryIntent ?? this.policy.intent,
      entryWorkflowType: this.entryWorkflowType ?? this.policy.workflowType,
      reconciledIntent: this.reconciledIntent,
      reconciledWorkflowType: this.reconciledWorkflowType,
      capabilityEscalations: this.capabilityEscalations,
      budgetManager: this.budgetManager,
      failedActionMemory: this.failedActionMemory,
      toolResultCache: this.toolResultCache,
    });
  }

  private restoreRuntimeSnapshot(state?: PausedRunRuntimeState): void {
    if (!state) return;
    if (state.entryIntent) this.entryIntent = state.entryIntent;
    if (state.entryWorkflowType) this.entryWorkflowType = state.entryWorkflowType;
    this.reconciledIntent = state.reconciledIntent;
    this.reconciledWorkflowType = state.reconciledWorkflowType;
    restorePausedRunRuntimeState(
      {
        capabilityEscalations: this.capabilityEscalations,
        failedActionMemory: this.failedActionMemory,
        toolResultCache: this.toolResultCache,
        budgetManager: this.budgetManager,
      },
      state,
    );
  }

  private buildToolStepPipelineContext(): AgentToolStepPipelineContext {
    return {
      registry: this.options.registry,
      mode: this.policy.mode,
      permissionPolicy: this.policy.permissionPolicy,
      allowedPermissions: this.allowed,
      getIntent: () => this.getEffectiveIntent(),
      getWorkflowContext: () => this.getEffectiveWorkflowContext(),
      capabilityEscalations: this.capabilityEscalations,
      budgetManager: this.budgetManager,
      shellPolicy: this.options.shellPolicy,
      networkPolicy: this.options.networkPolicy,
      timeline: this.options.timeline,
      runId: this.options.runId,
      pauseOnPermissionRequest: this.pauseOnPermissionRequest,
      resolveScopedGrants: () => this.resolveScopedGrants(),
      preparePathAccess: (action) => this.preparePathAccess(action),
      runToolAction: (action, iteration, toolCallId, ctx) =>
        this.runToolAction(action, iteration, toolCallId, ctx),
      onCapabilityReconciled: (result) => {
        if (result.reconciledIntent) this.reconciledIntent = result.reconciledIntent;
        if (result.reconciledWorkflowType) this.reconciledWorkflowType = result.reconciledWorkflowType;
      },
    };
  }

  /** 统一工具执行管道：escalation → workflow → PermissionGuard → Budget → runToolAction */
  private async executeToolStep(input: {
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
    skipJitPause?: boolean;
  }): Promise<
    | { kind: "step"; step: AgentToolStep }
    | { kind: "pause"; result: AgentRunResult }
    | { kind: "budget"; result: AgentRunResult }
  > {
    const pipelineResult = await executeAgentToolStepPipeline(this.buildToolStepPipelineContext(), {
      action: input.action,
      iteration: input.iteration,
      toolCallId: input.toolCallId,
      steps: input.steps,
      goal: input.goal,
      messages: input.messages,
      skipJitPause: input.skipJitPause,
    });

    if (pipelineResult.kind === "pause") {
      return {
        kind: "pause",
        result: await this.pauseForToolPermission({
          step: pipelineResult.step,
          action: input.action,
          messages: input.messages,
          steps: pipelineResult.pauseSteps,
          modelTurns: input.modelTurns,
          goal: input.goal,
          system: input.system,
          sessionId: input.sessionId,
          consumedNotifications: input.consumedNotifications,
        }),
      };
    }

    if (pipelineResult.kind === "budget") {
      return {
        kind: "budget",
        result: await this.finishRun({
          answer: "",
          partialSummary: this.buildPartialAnswer(
            input.steps,
            pipelineResult.budgetExhausted,
            input.goal,
          ),
          steps: input.steps,
          iterations: input.modelTurns,
          reachedLimit: true,
          budgetExhausted: pipelineResult.budgetExhausted,
          consumedNotifications: input.consumedNotifications,
          sessionId: input.sessionId,
          userMessage: input.goal,
        }),
      };
    }

    return { kind: "step", step: pipelineResult.step };
  }

  private buildWorkflowBlockedStep(
    action: ToolAction,
    iteration: number,
    block: Parameters<typeof buildWorkflowBlockedToolStep>[0]["block"],
    toolCallId?: string,
  ): AgentToolStep {
    const tool = this.options.registry.get(action.tool);
    return buildWorkflowBlockedToolStep({
      action,
      iteration,
      toolCallId,
      toolPermission: tool?.permission,
      block,
    });
  }

  private buildPermissionBlockedStep(
    action: ToolAction,
    iteration: number,
    reason: string,
    toolCallId: string | undefined,
    permission: ToolPermission | undefined,
  ): AgentToolStep {
    return buildPermissionBlockedToolStep({
      action,
      iteration,
      toolCallId,
      toolPermission: permission,
      reason,
    });
  }

  private buildSystemPrompt(extra?: string): string {
    return buildAgentSystemPrompt({
      registry: this.options.registry,
      allowedPermissions: this.allowed,
      isToolExposed: (toolName) => this.isToolExposedToModel(toolName),
      systemHint: this.policy.systemHint,
      workflowCapabilityHint: buildWorkflowCapabilityHint({
        intent: this.getEffectiveIntent(),
        reconciledWorkflowType: this.reconciledWorkflowType,
        reconciledIntent: this.reconciledIntent,
      }),
      extra,
    });
  }

  /** 子 Agent 内循环按派生深度门控 dispatch_subagent，不支持无限递归。 */
  private isToolExposedToModel(toolName: string): boolean {
    if (toolName === DISPATCH_SUBAGENT_TOOL_NAME) {
      const depth = this.options.subAgentDispatchDepth ?? 0;
      const max = this.options.maxSubAgentDispatchDepth ?? 1;
      return depth < max;
    }
    return true;
  }

  private buildExecutionMeta(input: {
    steps: AgentToolStep[];
    iterations: number;
    stopReason: AgentStopReason;
    budgetExhausted?: RunBudgetKey;
    goal: string;
    completionGuard?: CompletionGuardResult;
    partialSummary?: string;
  }): AgentExecutionMeta {
    return buildAgentExecutionMeta({
      ...input,
      policy: this.policy,
      effectiveIntent: this.getEffectiveIntent(),
      reconciledWorkflowType: this.reconciledWorkflowType,
      reconciledIntent: this.reconciledIntent,
      entryIntent: this.entryIntent,
      entryWorkflowType: this.entryWorkflowType,
      budget: this.budget,
      budgetManager: this.budgetManager,
      finalizer: this.finalizer,
      workflowProposals: this.workflowProposals,
      workflowDebugAnalyses: this.workflowDebugAnalyses,
      workflowRefactorPlans: this.workflowRefactorPlans,
      workflowInternalPlans: this.workflowInternalPlans,
      workflowWritePhases: this.workflowWritePhases,
      workflowDebugFixes: this.workflowDebugFixes,
      workflowSwitch: this.workflowSwitch,
      capabilityEscalations: this.capabilityEscalations,
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
      location: buildLocationMeta(steps),
    });
  }

  private createPermissionRequestFromStep(step: AgentToolStep): PermissionRequestPayload {
    return createJitPermissionRequestFromStep({
      permissionRequestStore: this.permissionRequestStore,
      step,
      runId: this.options.runId ?? "unknown-run",
      sessionId: this.options.sessionId,
      projectId: this.options.projectId,
      intent: this.getEffectiveIntent(),
      executionStage: this.policy.executionStage,
      planVariant: this.policy.planVariant,
    });
  }

  /** 计划阶段产出 final 后是否生成交接（凡 plan 意图均生成交接面板）。 */
  private shouldCreatePlanHandoff(): boolean {
    if (this.options.skipPlanHandoff) return false;
    return this.policy.mode === "plan" && this.policy.intent === "plan";
  }

  /** 冻结当前对话快照，供计划交接或权限批准后忠实续跑。 */
  private snapshotPausedRun(input: {
    sessionId?: string;
    goal: string;
    system?: string;
    messages: ChatMessage[];
    steps: AgentToolStep[];
    modelTurns: number;
    pendingAction?: { tool: string; input?: Record<string, unknown> };
    resumeMode?: AgentRunMode;
    workflowProposals?: AgentWorkflowProposal[];
    workflowDebugAnalyses?: AgentWorkflowDebugAnalysis[];
    workflowRefactorPlans?: AgentWorkflowRefactorPlan[];
    workflowInternalPlans?: AgentWorkflowInternalPlan[];
  }): void {
    this.pausedRunStore.save(
      buildPausedRunSnapshot({
        runId: this.options.runId ?? "unknown-run",
        sessionId: input.sessionId,
        goal: input.goal,
        system: input.system,
        messages: input.messages,
        steps: input.steps,
        modelTurns: input.modelTurns,
        pendingAction: input.pendingAction,
        mode: this.policy.mode,
        permissionPolicy: this.policy.permissionPolicy,
        resumeMode: input.resumeMode,
        runtimeState: this.buildRuntimeSnapshot(),
        workflowProposals: input.workflowProposals ?? this.workflowProposals,
        workflowDebugAnalyses: input.workflowDebugAnalyses ?? this.workflowDebugAnalyses,
        workflowRefactorPlans: input.workflowRefactorPlans ?? this.workflowRefactorPlans,
        workflowInternalPlans: input.workflowInternalPlans ?? this.workflowInternalPlans,
      }),
    );
  }

  /** 工具级 JIT 暂停：申请权限并冻结对话，等待批准后从被阻塞工具处续跑。 */
  private async pauseForToolPermission(input: {
    step: AgentToolStep;
    action: ToolAction;
    messages: ChatMessage[];
    steps: AgentToolStep[];
    modelTurns: number;
    goal: string;
    system?: string;
    sessionId?: string;
    consumedNotifications: AgentNotification[];
  }): Promise<AgentRunResult> {
    const permissionRequest = this.createPermissionRequestFromStep(input.step);
    this.snapshotPausedRun({
      sessionId: input.sessionId,
      goal: input.goal,
      system: input.system,
      messages: input.messages,
      steps: input.steps.slice(0, -1),
      modelTurns: input.modelTurns,
      pendingAction: { tool: input.action.tool, input: input.action.input },
    });
    return await this.finishRun({
      answer: "",
      steps: input.steps,
      iterations: input.modelTurns,
      reachedLimit: false,
      consumedNotifications: input.consumedNotifications,
      sessionId: input.sessionId,
      userMessage: input.goal,
      stopReason: "awaiting_permission",
      permissionRequest,
      awaitingPermission: true,
    });
  }

  /** 续跑时先忠实执行被批准的待办工具；若再次被阻塞则再次暂停，否则记录结果并返回 null 继续循环。 */
  private async resumePendingAction(input: {
    pendingAction: { tool: string; input?: Record<string, unknown> };
    messages: ChatMessage[];
    steps: AgentToolStep[];
    modelTurns: number;
    goal: string;
    system?: string;
    sessionId?: string;
    consumedNotifications: AgentNotification[];
    injectNotifications: () => void;
  }): Promise<AgentRunResult | null> {
    const action: ToolAction = {
      action: "tool",
      tool: input.pendingAction.tool,
      input: input.pendingAction.input,
    };
    const iteration = input.modelTurns;
    const toolCallId = this.makeToolCallId(iteration, action.tool);
    const execResult = await this.executeToolStep({
      action,
      iteration,
      toolCallId,
      steps: input.steps,
      goal: input.goal,
      messages: input.messages,
      sessionId: input.sessionId,
      system: input.system,
      modelTurns: input.modelTurns,
      consumedNotifications: input.consumedNotifications,
      skipJitPause: true,
    });
    if (execResult.kind === "pause" || execResult.kind === "budget") {
      return execResult.result;
    }
    const step = execResult.step;
    input.steps.push(step);
    this.options.onStep?.(step);
    if (
      step.blocked &&
      step.confirmationRequest?.status === "waiting_confirmation" &&
      this.pauseOnPermissionRequest
    ) {
      return await this.pauseForToolPermission({
        step,
        action,
        messages: input.messages,
        steps: input.steps,
        modelTurns: input.modelTurns,
        goal: input.goal,
        system: input.system,
        sessionId: input.sessionId,
        consumedNotifications: input.consumedNotifications,
      });
    }
    this.recordToolStepMessages({
      messages: input.messages,
      step,
      steps: input.steps,
      goal: input.goal,
      sessionId: input.sessionId,
    });
    const autoVerificationStep = await this.runEditAutoVerification(
      step,
      input.steps,
      iteration,
      input.goal,
    );
    if (autoVerificationStep) {
      input.steps.push(autoVerificationStep);
      this.options.onStep?.(autoVerificationStep);
      this.recordToolStepMessages({
        messages: input.messages,
        step: autoVerificationStep,
        steps: input.steps,
        goal: input.goal,
        sessionId: input.sessionId,
      });
    }
    input.injectNotifications();
    return null;
  }

  private writeAgentDecisionTrace(event: {
    iteration: number;
    action: "tool" | "final" | "parse_error" | "final_guard_rejected";
    tool?: string;
    toolCallId?: string;
    thought?: string;
    inputPreview?: string;
    rawPreview?: string;
    answerLength?: number;
    completionStatus?: string;
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
    this.options.trace?.write(buildRunUsageSummaryTracePayload({
      steps,
      executionMeta,
      modelTurnMetrics: this.modelTurnMetrics,
      runId: this.options.runId,
      sessionId: this.options.sessionId,
      taskId: this.options.taskId,
      mode: this.policy.mode,
    }));
  }

  private makeToolCallId(iteration: number, tool: string): string {
    const prefix = this.options.runId ?? this.options.requestId ?? this.options.taskId ?? "agent";
    return `${prefix}:iter-${iteration}:${tool}`;
  }
}

export { parseAction, stripModelNoise } from "./AgentActionParser.js";
export { renderNotifications } from "./AgentNotificationRenderer.js";
export type { AgentAction, FinalAction, ToolAction } from "./AgentActionParser.js";
export type { LoopChatFn, LoopChatResponse } from "../model-router/agent-chat-types.js";
