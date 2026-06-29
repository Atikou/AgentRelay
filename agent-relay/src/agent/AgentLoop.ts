import type { AgentNotification } from "../background/types.js";
import { readMergeCount } from "../background/NotificationQueue.js";
import type { NotificationQueue } from "../background/NotificationQueue.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { ModelTaskType } from "../model/taskType.js";
import type { ChatMessage, ChatRequest, ModelResponse } from "../model/types.js";
import type { AgentPromptStrategySummary, AgentRouterDecisionSummary, AgentRoutingMeta } from "../model-router/agent-routing-summary.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import { DISPATCH_SUBAGENT_TOOL_NAME } from "../tools/subagentTool.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { AgentStepPlan } from "../plan/types.js";
import { assertWithinCostBudget, sumModelTurnCost } from "../util/costBudget.js";
import { wrapUntrustedToolOutput } from "../util/injection.js";
import { redactPreview } from "../util/redact.js";
import { buildAgentSystemPrompt } from "./AgentSystemPromptBuilder.js";
import { buildWorkflowCapabilityHint } from "./AgentWorkflowCapabilityHint.js";
import {
  assessSubagentDispatchGuard,
  assessSubagentSideEffectGuard,
  renderDispatchSubagentFailure,
  renderSubagentFinalConvergencePrompt,
} from "./SubagentDispatchGuard.js";
import { FailedActionMemory } from "./recovery/FailedActionMemory.js";
import { RunToolResultCache } from "./recovery/RunToolResultCache.js";
import {
  cacheInvalidationPath,
  planSystemRecovery,
  renderCacheReuseContext,
} from "./recovery/SystemToolRecovery.js";
import type { ToolOutcome } from "../tools/toolOutcome.js";
import { resolveToolOutcome } from "../tools/toolOutcome.js";
import {
  applyOutcomeToStep,
  renderBlockedRecoveryMessage,
  renderExecutionErrorMessage,
  renderToolOutcomeMessage,
  traceStatusForOutcome,
} from "./recovery/renderToolOutcome.js";
import { EditAutoVerificationWorkflow } from "./EditAutoVerificationWorkflow.js";
import {
  applyEscalationBudget,
  formatCapabilityEscalationTimelineContent,
  resolveEffectiveIntent,
} from "./capabilityEscalationRuntime.js";
import {
  buildEffectiveWorkflowContext,
  effectiveWorkflowRoute,
  type EffectiveWorkflowContext,
} from "./EffectiveWorkflowContext.js";
import type { PausedRunRuntimeState } from "./PausedRunStore.js";
import {
  evaluateCapabilityEscalation,
  renderCapabilityEscalationContext,
  type CapabilityEscalation,
  type CapabilityEscalationRecord,
} from "./CapabilityEscalation.js";
import { defaultWorkflowRouter } from "./WorkflowRouter.js";
import { assessWorkflowToolAccess, type WorkflowCapabilityAssessment } from "./WorkflowCapability.js";
import { extractSideEffectSummary } from "./sideEffectFromSteps.js";
import { evaluateCompletionGuard, type CompletionGuardResult } from "./completion/CompletionFinalGuard.js";
import { buildToolLedger, toolLedgerToSummary } from "./completion/ToolLedger.js";
import { ToolExecutionGateway } from "./ToolExecutionGateway.js";
import { EditProposalWorkflow } from "./EditProposalWorkflow.js";
import { MAX_WORKFLOW_CORRECTION_ATTEMPTS, WorkflowCorrectionWorkflow } from "./WorkflowCorrectionWorkflow.js";
import { hasPlanningPhaseArtifacts, resolveWorkflowTaskState } from "./WorkflowTaskState.js";
import { WorkflowExecutor } from "./WorkflowExecutor.js";
import {
  renderWorkflowSwitchContext,
  resolveWorkflowSwitch,
  type WorkflowSessionSnapshot,
} from "./WorkflowSessionSwitch.js";
import { presentExecutionState } from "./presentation/ExecutionStatePresenter.js";
import { defaultSessionTaskManager } from "./task/SessionTaskManager.js";
import { buildWorkflowState } from "./WorkflowStateCenter.js";
import { orchestrateWorkflowWrite } from "./workflowWriteOrchestrator.js";
import { buildWorkflowFollowupContexts } from "./workflowFollowupContexts.js";
import { ToolRecoveryWorkflow } from "./ToolRecoveryWorkflow.js";
import {
  buildLocationMeta,
  buildWorkflowCorrections,
  buildWorkflowDiffs,
  buildWorkflowVerifications,
} from "./workflowExecutionMeta.js";
import {
  buildToolResultLayers,
  clipModelToolJson,
} from "../util/toolResultLayers.js";
import type { AgentModelTurnEvent } from "./AgentModelTurn.js";
import type { AgentTimelineService } from "./timeline/AgentTimelineService.js";
import { mapToolToActivityStep } from "./timeline/toolStepMapper.js";
import { type ToolPermission } from "../core/permissions.js";
import {
  resolveEffectivePermissions,
} from "../policy/PermissionPolicy.js";
import { evaluatePermissionGuard } from "../policy/PermissionGuard.js";
import {
  buildPathConfirmationRequest,
  PathPolicy,
  type ToolPathPreparation,
} from "../policy/PathPolicy.js";
import type { WorkspaceGrantStore, WorkspaceScopePermission } from "../policy/WorkspaceScopeManager.js";
import {
  defaultPermissionRequestStore,
  permissionItemsFromConfirmation,
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
import {
  planHandoffMessageForVariant,
} from "./planHandoffMessages.js";
import type { AgentToolStep } from "./toolStep.js";
import { countToolOutcomeUsage, isFailedToolStep, isSuccessfulToolStep, stepPlanTraceStatus } from "./toolStepOutcome.js";
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
    const confirmationRequest = pathAccess.decision.needsConfirmation
      ? buildPathConfirmationRequest({
          toolName: action.tool,
          decision: pathAccess.decision,
          intent: this.getEffectiveIntent(),
          permissionPolicy: this.policy.permissionPolicy,
        })
      : undefined;
    return {
      iteration,
      toolCallId,
      tool: action.tool,
      input: action.input ?? {},
      permission: tool?.permission,
      thought: action.thought,
      ok: false,
      blocked: true,
      executed: false,
      blockedReasonKind: "permission",
      outcomeClass: "execution_error",
      outcomeKind: pathAccess.decision.needsConfirmation ? "permission_required" : "permission_denied",
      error: pathAccess.decision.needsConfirmation
        ? `跨工作区访问需要用户授权：${pathAccess.decision.normalizedPath}`
        : `路径策略拒绝访问：${pathAccess.decision.reason}`,
      confirmationRequest,
      workspaceAccess: pathAccess.audit,
    };
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
    this.capabilityEscalations = [];
    this.reconciledWorkflowType = undefined;
    this.reconciledIntent = undefined;
    this.entryIntent = this.policy.intent;
    this.entryWorkflowType = this.policy.workflowType;
    this.pendingWritePhaseContext = undefined;
    this.toolResultCache.invalidateAll();
    this.failedActionMemory = new FailedActionMemory(this.policy.budget.maxRepeatedToolFailures);
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
    const ctx = this.options.contextManager;
    let sessionId =
      pausedRun?.sessionId ?? this.options.resumeState?.sessionId ?? this.options.sessionId;
    const steps: AgentToolStep[] = pausedRun
      ? [...pausedRun.steps]
      : isResume
        ? [...(this.options.resumeState?.completedToolSteps ?? [])]
        : [];
    const consumedNotifications: AgentNotification[] = [];
    let modelTurns = pausedRun?.modelTurns ?? 0;
    let analysisStepId: string | undefined;

    try {
    if (!isResume && !pausedRun && this.options.timeline) {
      const runId = this.options.runId ?? this.options.timeline.getRun()?.id ?? "";
      const s = this.options.timeline.startStep({
        runId,
        type: "analysis",
        title: "正在分析任务",
        content: effectiveGoal.slice(0, 300),
      });
      analysisStepId = s.id;
    }
    if (ctx && !sessionId) {
      sessionId = ctx.createSession().id;
    }
    if (ctx && sessionId && !isResume && !pausedRun) {
      ctx.saveUserMessage(sessionId, userMessage, this.options.runId);
    }

    // 续跑：直接复用暂停时的对话快照，忠实从同一段对话继续（不重建上下文、不重跑预扫描工作流）。
    const messages: ChatMessage[] = pausedRun
      ? [...pausedRun.messages]
      : ctx && sessionId
        ? ctx.buildChatMessages(
            await ctx.restoreContextPackage(sessionId, effectiveGoal),
            this.buildSystemPrompt(system),
            { phase: "pre_call", currentUser: isResume ? undefined : effectiveGoal },
          )
        : [
            { role: "system", content: this.buildSystemPrompt(system) },
            { role: "user", content: effectiveGoal },
          ];

    if (isResume) {
      messages.push({
        role: "system",
        content:
          "AgentRelay runtime resume: continue from the saved RunState. This is not a user message.",
      });
    }

    const injectNotifications = () => {
      const notes = this.drainNotifications();
      if (notes.length === 0) return;
      consumedNotifications.push(...notes);
      const rendered = renderNotifications(notes);
      const wrapped = wrapUntrustedToolOutput("notification", rendered);
      messages.push({
        role: "system",
        content: typeof wrapped === "string" ? wrapped : JSON.stringify(wrapped),
      });
    };

    injectNotifications();

    if (!pausedRun && sessionId && !isResume && this.policy.intent && this.policy.workflowType) {
      const prevCtx = defaultSessionTaskManager.getContext(sessionId);
      const previous: WorkflowSessionSnapshot | undefined = prevCtx
        ? {
            sessionId,
            intent: prevCtx.intent,
            workflowType: prevCtx.workflowType,
            updatedAt: prevCtx.updatedAt,
            runId: prevCtx.lastRunId,
          }
        : undefined;
      this.workflowSwitch = resolveWorkflowSwitch({
        previous,
        current: {
          intent: this.getEffectiveIntent(),
          workflowType: this.policy.workflowType,
        },
      });
      if (this.workflowSwitch?.switched) {
        messages.push({
          role: "system",
          content: renderWorkflowSwitchContext(this.workflowSwitch),
        });
      }
    }

    if (!pausedRun) {
      const workflowResult = await this.runWorkflowExecutor(effectiveGoal, isResume, sessionId);
      this.workflowProposals = workflowResult.workflowProposals;
      this.workflowDebugAnalyses = workflowResult.workflowDebugAnalyses;
      this.workflowRefactorPlans = workflowResult.workflowRefactorPlans;
      this.workflowInternalPlans = workflowResult.workflowInternalPlans;
      for (const step of workflowResult.steps) {
        steps.push(step);
        this.options.onStep?.(step);
      }
      const preflightCount = workflowResult.steps.filter((s) => s.preflight && !s.cached).length;
      if (preflightCount > 0) {
        this.budgetManager.recordPreflightTool(preflightCount);
      }
      for (const modelContext of workflowResult.modelContexts) {
        messages.push({ role: "system", content: modelContext });
      }
    }

    // 续跑且存在被批准的待执行工具：先忠实执行它，再进入正常循环。
    if (pausedRun?.pendingAction) {
      const resumed = await this.resumePendingAction({
        pendingAction: pausedRun.pendingAction,
        messages,
        steps,
        modelTurns,
        goal: effectiveGoal,
        system,
        sessionId,
        consumedNotifications,
        injectNotifications,
      });
      if (resumed) return resumed;
    } else if (pausedRun) {
      // 计划→执行交接：计划已在对话历史中。
      // 快照里的首条 system 仍是“计划/只读”阶段提示，这里换成当前（implement）阶段的系统提示，
      // 否则模型会以为自己仍处于只读计划模式而拒绝执行。
      if (pausedRun.resumeMode) {
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
    }

    if (this.options.timeline) {
      const tl = this.options.timeline;
      const runId = this.options.runId ?? tl.getRun()?.id ?? "";
      if (analysisStepId) {
        tl.completeStep(analysisStepId, "已识别任务目标，准备执行");
      }
      if (this.workflowProposals.length > 0) {
        const preview = this.workflowProposals
          .map((p) => p.goal || p.permissionSummary)
          .filter(Boolean)
          .slice(0, 5)
          .join("；");
        const plan = tl.startStep({
          runId,
          type: "plan",
          title: "正在生成计划",
          content: preview || "工作流方案已就绪",
        });
        tl.completeStep(plan.id, "计划阶段完成");
      }
    }

    while (modelTurns < this.budget.maxModelTurns) {
      this.assertNotCancelled();
      const runtimeExhausted = this.budgetManager.findRuntimeExhaustion();
      if (runtimeExhausted) {
        return await this.finishRun({
          answer: "",
          partialSummary: this.buildPartialAnswer(steps, runtimeExhausted, effectiveGoal),
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
      this.options.onModelTurn?.({ iteration, phase: "started" });
      const modelStart = Date.now();
      let response: LoopChatResponse;
      try {
        assertWithinCostBudget(
          sumModelTurnCost(this.modelTurnMetrics.map((m) => m.costUsd)),
          this.options.maxCostUsdPerRun,
        );
        response = await this.options.chat(
          {
            messages,
            temperature: 0.2,
            onToken: this.options.onToken,
            signal: this.options.signal,
          },
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
        if (this.isCancelledError(error)) throw error;
        this.recordModelTurn({
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
        this.options.onModelTurn?.({
          iteration,
          phase: "parse_error",
          contentPreview: redactPreview(response.content, 400),
          clientName: response.clientName,
          modelName: response.modelName,
          latencyMs: Math.round(response.latencyMs || Date.now() - modelStart),
        });
        this.writeAgentDecisionTrace({
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
      if (ctx && sessionId && action.action !== "final") {
        ctx.saveAssistantToolAction(sessionId, response.content, this.options.runId, {
          clientName: response.clientName,
          modelName: response.modelName,
        });
      }

      if (action.action === "final") {
        this.options.onModelTurn?.({
          iteration,
          phase: "completed",
          action: "final",
          contentPreview: redactPreview(action.answer, 400),
          clientName: response.clientName,
          modelName: response.modelName,
          latencyMs: Math.round(response.latencyMs || Date.now() - modelStart),
        });
        this.writeAgentDecisionTrace({
          iteration,
          action: "final",
          answerLength: action.answer?.length ?? 0,
        });
        // 计划阶段完成：生成 planHandoff（与工具级 permissionRequest 分离），冻结快照等待用户选择是否执行。
        if (!pausedRun && this.shouldCreatePlanHandoff() && action.answer.trim()) {
          const planVariant = this.policy.planVariant ?? "plan_only";
          const handoffMessage = planHandoffMessageForVariant(planVariant);
          const planHandoff = this.planHandoffStore.create({
            runId: this.options.runId ?? "unknown-run",
            sessionId,
            planMarkdown: action.answer,
            planVariant,
            message: handoffMessage,
          });
          this.snapshotPausedRun({
            sessionId,
            goal: effectiveGoal,
            system,
            messages,
            steps,
            modelTurns: iteration,
            resumeMode: "implement",
          });
          if (ctx && sessionId) {
            ctx.saveTrustedModelFinalAnswer(sessionId, action.answer, this.options.runId, {
              clientName: response.clientName,
              modelName: response.modelName,
            });
          }
          return await this.finishRun({
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
          intent: this.getEffectiveIntent(),
          reconciledIntent: this.reconciledIntent,
          capabilityEscalations: this.capabilityEscalations,
          mode: this.policy.mode,
          answer: action.answer,
          steps,
        });
        if (!guard.accepted) {
          this.writeAgentDecisionTrace({
            iteration,
            action: "final_guard_rejected",
            rawPreview: redactPreview(action.answer, 400),
            completionStatus: guard.status,
          });
          if (ctx && sessionId) {
            ctx.saveRawModelFinal(sessionId, guard.rawModelAnswer ?? action.answer, this.options.runId, {
              clientName: response.clientName,
              modelName: response.modelName,
            });
            if (guard.guardedAnswer) {
              ctx.saveGuardedFinalAnswer(sessionId, guard.guardedAnswer, this.options.runId);
            }
          }
          return await this.finishRun({
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
        if (ctx && sessionId) {
          if (guard.trustedForMemory) {
            ctx.saveTrustedModelFinalAnswer(
              sessionId,
              guard.visibleAnswer ?? action.answer,
              this.options.runId,
              {
              clientName: response.clientName,
              modelName: response.modelName,
            },
            );
          } else if (guard.guardedAnswer) {
            ctx.saveGuardedFinalAnswer(sessionId, guard.guardedAnswer, this.options.runId);
          } else {
            ctx.saveRawModelFinal(sessionId, action.answer, this.options.runId, {
              clientName: response.clientName,
              modelName: response.modelName,
            });
          }
        }
        return await this.finishRun({
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

      // 工具调用
      const toolCallId = this.makeToolCallId(iteration, action.tool);
      this.options.onModelTurn?.({
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
      this.writeAgentDecisionTrace({
        iteration,
        action: "tool",
        tool: action.tool,
        toolCallId,
        thought: action.thought,
        inputPreview: redactPreview(action.input ?? {}, 500),
      });

      const execResult = await this.executeToolStep({
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
      const step = execResult.step;
      steps.push(step);
      this.options.onStep?.(step);
      if (step.blocked) {
        this.recordToolStepMessages({
          messages,
          step,
          steps,
          goal: effectiveGoal,
          sessionId,
        });
        continue;
      }
      this.recordToolStepMessages({
        messages,
        step,
        steps,
        goal: effectiveGoal,
        sessionId,
      });
      const invalidated = cacheInvalidationPath(step);
      if (invalidated) this.toolResultCache.invalidatePath(invalidated);
      await this.maybeRunSystemRecovery({
        step,
        messages,
        steps,
        goal: effectiveGoal,
        sessionId,
        iteration,
      });
      if (this.failedActionMemory.shouldForcePartialFinal(step)) {
        const recoverySummary = this.failedActionMemory.buildSummaryContext();
        if (recoverySummary) {
          messages.push({ role: "system", content: recoverySummary });
        }
        return await this.finishRun({
          answer: "",
          partialSummary: [
            this.finalizer.buildRecoveryExhaustedAnswer({ goal: effectiveGoal, steps }),
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
          answer: "",
          partialSummary: this.buildPartialAnswer(steps, postToolRuntimeExhausted, effectiveGoal),
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
      answer: "",
      partialSummary: this.buildPartialAnswer(steps, "maxModelTurns", effectiveGoal),
      steps,
      iterations: modelTurns,
      reachedLimit: true,
      budgetExhausted: "maxModelTurns",
      consumedNotifications,
      sessionId,
      userMessage: effectiveGoal,
    });
    } catch (err) {
      if (this.isCancelledError(err)) {
        return await this.finishRun({
          answer: "",
          steps,
          iterations: modelTurns,
          reachedLimit: false,
          stopReason: "user_cancelled",
          consumedNotifications,
          sessionId,
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
    const isResume = Boolean(this.options.resumeState);
    this.writeAgentStepPlanTrace(input.steps);
    const ctx = this.options.contextManager;
    let compressed = false;
    if (ctx && input.sessionId) {
      const result = await ctx.finalizeTurn(input.sessionId, input.userMessage);
      compressed = result.compressed !== null;
    }
    const guard = input.completionGuard;
    const stopReason =
      guard?.stopReason ??
      input.stopReason ??
      (input.reachedLimit ? "budget_exhausted" : "completed");
    const answer = input.answer;
    const executionMeta = this.buildExecutionMeta({
      steps: input.steps,
      iterations: input.iterations,
      stopReason,
      budgetExhausted: input.budgetExhausted,
      goal: input.userMessage,
      completionGuard: guard,
      partialSummary: input.partialSummary,
    });
    executionMeta.planVariant = this.policy.planVariant;
    this.writeRunUsageSummary(input.steps, executionMeta);

    // 工具级 JIT 权限在 run() 的 tool 分支处理；计划交接在 final 分支生成 planHandoff。
    const permissionRequest = input.permissionRequest;
    const planHandoff = input.planHandoff;
    const awaitingPermission = input.awaitingPermission === true;
    const awaitingPlanHandoff = input.awaitingPlanHandoff === true;

    if (
      input.sessionId &&
      !isResume &&
      this.policy.intent &&
      this.policy.workflowType
    ) {
      defaultSessionTaskManager.updateFromRun({
        sessionId: input.sessionId,
        taskId: this.options.taskId,
        goal: input.userMessage,
        intent: this.getEffectiveIntent(),
        workflowType: this.reconciledWorkflowType ?? this.policy.workflowType,
        entryIntent: this.entryIntent ?? this.policy.intent,
        entryWorkflowType: this.entryWorkflowType ?? this.policy.workflowType,
        reconciledIntent: this.reconciledIntent,
        reconciledWorkflowType: this.reconciledWorkflowType,
        runId: this.options.runId,
        stopReason,
        completionStatus: guard?.status,
        sideEffectsMet: guard ? guard.status === "completed_success" : undefined,
        sideEffectSummary: extractSideEffectSummary(input.steps),
        workflowTaskState: executionMeta.workflowTaskState,
        failed:
          stopReason === "error" ||
          executionMeta.workflowTaskState === "failed" ||
          input.steps.some((step) => isFailedToolStep(step)),
        failureSummary: input.steps.find((step) => isFailedToolStep(step))?.error
          ?? input.steps.find((step) => isFailedToolStep(step))?.outcomeMessage,
        relatedFiles: executionMeta.location?.locatedFiles,
      });
    }

    if (this.options.runStateStore && this.options.runId) {
      const cancelled = input.stopReason === "user_cancelled";
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
      } else if (!cancelled) {
        this.options.runStateStore.markCompleted(this.options.runId);
      }
    }

    this.finalizeActivityTimeline({
      ...input,
      answer,
      stopReason,
      partialSummary: input.partialSummary,
    });

    return {
      answer,
      steps: input.steps,
      iterations: input.iterations,
      reachedLimit: input.reachedLimit,
      awaitingPermission,
      awaitingPlanHandoff,
      permissionRequest,
      planHandoff,
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
    const toolText = this.renderToolResult(input.step, input.steps);
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

  private finalizeActivityTimeline(input: {
    answer: string;
    reachedLimit: boolean;
    budgetExhausted?: RunBudgetKey;
    stopReason?: AgentStopReason;
    completionGuard?: CompletionGuardResult;
    partialSummary?: string;
  }): void {
    const tl = this.options.timeline;
    if (!tl) return;
    const runId = this.options.runId ?? tl.getRun()?.id ?? "";
    const stop = input.stopReason ?? (input.reachedLimit ? "budget_exhausted" : "completed");
    if (stop === "user_cancelled") {
      tl.cancelRun("用户取消");
      return;
    }
    if (
      stop === "completed_partial" ||
      stop === "recovery_partial" ||
      stop === "misleading_completion" ||
      stop === "blocked_by_policy" ||
      input.completionGuard?.status === "historical_reference" ||
      input.completionGuard?.status === "completed_partial" ||
      input.completionGuard?.status === "misleading_completion" ||
      input.completionGuard?.status === "blocked_by_policy"
    ) {
      const title =
        stop === "misleading_completion"
          ? "检测到虚假完成"
          : stop === "recovery_partial"
            ? "部分完成 · 恢复预算耗尽"
            : "任务未完全完成";
      const summary =
        input.partialSummary ||
        input.completionGuard?.reason ||
        input.stopReason ||
        "";
      if (typeof tl.partialCompleteRun === "function") {
        tl.partialCompleteRun(summary.slice(0, 800), title);
      } else {
        tl.failRun(title);
      }
      return;
    }
    if (stop === "awaiting_permission") {
      const summary = input.partialSummary || input.completionGuard?.reason || "等待工具授权";
      tl.partialCompleteRun(summary.slice(0, 800), "等待工具授权");
      return;
    }
    if (stop === "completed" && !input.reachedLimit) {
      const summary = tl.startStep({
        runId,
        type: "summary",
        title: "任务完成",
        content: input.answer.slice(0, 400),
      });
      tl.completeStep(summary.id, input.answer.slice(0, 500));
      tl.completeRun(input.answer.slice(0, 800));
      return;
    }
    if (input.reachedLimit) {
      const ledger = this.budgetManager.ledgerSnapshot();
      const summary =
        input.partialSummary ||
        `运行预算耗尽：${input.budgetExhausted ?? "unknown"}（恢复 ${ledger.recoveryTurns}/${this.budget.maxRecoveryTurns}）`;
      if (typeof tl.partialCompleteRun === "function") {
        tl.partialCompleteRun(summary.slice(0, 800), "部分完成 · 预算耗尽");
      } else {
        tl.failRun(summary.slice(0, 800));
      }
      return;
    }
    tl.completeRun(input.answer.slice(0, 800));
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

  private buildCachedToolStep(
    base: AgentToolStep,
    tool: NonNullable<ReturnType<ToolRegistry["get"]>>,
    cachedOutput: unknown,
    input: Record<string, unknown>,
  ): AgentToolStep {
    const layers = buildToolResultLayers(base.tool, cachedOutput, {
      compact: this.options.contextManager
        ? (t, out) => this.options.contextManager!.compactToolOutput(t, out)
        : undefined,
    });
    const outcome = resolveToolOutcome(base.tool, cachedOutput);
    this.budgetManager.recordCacheHit();
    return applyOutcomeToStep(
      { ...base, permission: tool.permission },
      outcome,
      {
        executed: false,
        cached: true,
        output: layers.modelVisible,
        resultLayers: layers,
        toolCallId: base.toolCallId,
      },
    );
  }

  private async runToolAction(
    action: ToolAction,
    iteration: number,
    toolCallId: string,
    ctx: { steps: AgentToolStep[]; goal: string; isRecovery?: boolean; isPreflight?: boolean },
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
    const tl = this.options.timeline;
    const activityRunId = this.options.runId ?? tl?.getRun()?.id ?? "";
    let activityStepId: string | undefined;
    const startActivity = () => {
      if (!tl || !activityRunId) return;
      const mapped = mapToolToActivityStep(action.tool, action.input ?? {});
      activityStepId = tl.startStep({ runId: activityRunId, ...mapped }).id;
      tl.recordRawToolCall({
        tool: action.tool,
        input: action.input ?? {},
        iteration,
        toolCallId,
        at: new Date().toISOString(),
      });
    };
    const failActivity = (msg: string, extra?: { durationMs?: number; outcomeKind?: string; workspaceAccess?: ToolPathPreparation["audit"] }) => {
      if (activityStepId && tl) {
        tl.failStep(activityStepId, msg, {
          durationMs: extra?.durationMs,
          outcomeClass: "execution_error",
          outcomeKind: extra?.outcomeKind,
          crossWorkspace: extra?.workspaceAccess?.crossWorkspace,
          matchedRoot: extra?.workspaceAccess?.matchedRoot,
          grantId: extra?.workspaceAccess?.grantId,
          pathRisk: extra?.workspaceAccess?.pathRisk,
        });
      }
    };
    const okActivity = (msg: string, extra?: { durationMs?: number; changedFiles?: string[]; workspaceAccess?: ToolPathPreparation["audit"] }) => {
      if (activityStepId && tl) {
        tl.completeStep(activityStepId, msg, {
          durationMs: extra?.durationMs,
          resultSummary: msg,
          changedFiles: extra?.changedFiles,
          outcomeClass: "observation_success",
          crossWorkspace: extra?.workspaceAccess?.crossWorkspace,
          matchedRoot: extra?.workspaceAccess?.matchedRoot,
          grantId: extra?.workspaceAccess?.grantId,
          pathRisk: extra?.workspaceAccess?.pathRisk,
        });
      }
    };
    const observeActivity = (
      msg: string,
      extra?: { durationMs?: number; outcomeKind?: string; exitCode?: number; command?: string; workspaceAccess?: ToolPathPreparation["audit"] },
    ) => {
      if (activityStepId && tl) {
        tl.completeStep(activityStepId, msg, {
          durationMs: extra?.durationMs,
          resultSummary: msg,
          outcomeClass: "observation_failure",
          outcomeKind: extra?.outcomeKind,
          exitCode: extra?.exitCode,
          command: extra?.command,
          crossWorkspace: extra?.workspaceAccess?.crossWorkspace,
          matchedRoot: extra?.workspaceAccess?.matchedRoot,
          grantId: extra?.workspaceAccess?.grantId,
          pathRisk: extra?.workspaceAccess?.pathRisk,
        });
      }
    };

    if (!tool) {
      startActivity();
      failActivity(`未知工具：${action.tool}`);
      return { ...base, error: `未知工具：${action.tool}` };
    }
    startActivity();
    if (!this.isToolExposedToModel(action.tool)) {
      const err = `工具「${action.tool}」仅主 Agent 可用，当前上下文不可调用。`;
      failActivity(err);
      return {
        ...base,
        permission: tool.permission,
        error: err,
      };
    }
    const withPermission = { ...base, permission: tool.permission };

    const inputRecord = (action.input ?? {}) as Record<string, unknown>;
    const pathAccess = this.preparePathAccess(action);
    if (pathAccess) {
      this.options.trace?.write({
        type: "path_access_decision",
        tool: action.tool,
        runId: this.options.runId,
        sessionId: this.options.sessionId,
        taskId: this.options.taskId,
        toolCallId,
        allowed: pathAccess.decision.allowed,
        needsConfirmation: pathAccess.decision.needsConfirmation,
        reason: pathAccess.decision.reason,
        operation: pathAccess.decision.requiredPermission,
        normalizedPath: pathAccess.decision.normalizedPath,
        matchedRoot: pathAccess.audit.matchedRoot,
        crossWorkspace: pathAccess.audit.crossWorkspace,
        permissionSource: pathAccess.audit.permissionSource,
        pathRisk: pathAccess.audit.pathRisk,
        workspaceScopeId: pathAccess.audit.workspaceScopeId,
        grantId: pathAccess.audit.grantId,
      });
      this.options.workspaceGrantStore?.recordAccess({
        runId: this.options.runId,
        sessionId: this.options.sessionId,
        taskId: this.options.taskId,
        toolCallId,
        toolName: action.tool,
        operation: pathAccess.decision.requiredPermission,
        normalizedPath: pathAccess.decision.normalizedPath,
        matchedRoot: pathAccess.audit.matchedRoot,
        workspaceScopeId: pathAccess.audit.workspaceScopeId,
        grantId: pathAccess.audit.grantId,
        permissionSource: pathAccess.audit.permissionSource,
        decision: pathAccess.decision.allowed
          ? "allowed"
          : pathAccess.decision.needsConfirmation
            ? "needs_confirmation"
            : "denied",
        reason: pathAccess.decision.reason,
        crossWorkspace: pathAccess.audit.crossWorkspace,
        pathRisk: pathAccess.audit.pathRisk,
        pathRiskTier: pathAccess.audit.pathRiskTier,
      });
    }
    if (pathAccess && !pathAccess.decision.allowed) {
      const step = this.buildPathBlockedStep(action, iteration, pathAccess, toolCallId);
      failActivity(step.error ?? "路径策略拒绝访问", { outcomeKind: step.outcomeKind, workspaceAccess: pathAccess.audit });
      this.failedActionMemory.record(step);
      return step;
    }
    const cacheInputRecord = pathAccess?.grantVersionKey
      ? { ...inputRecord, _workspaceGrantVersion: pathAccess.grantVersionKey }
      : inputRecord;
    if (!ctx.isRecovery) {
      const cached = this.toolResultCache.lookup(action.tool, cacheInputRecord);
      if (cached) {
        okActivity("复用本 run 缓存结果");
        return this.buildCachedToolStep(withPermission, tool, cached.entry.output, inputRecord);
      }
    }

    const subagentDispatchGuard = assessSubagentDispatchGuard(action, ctx.steps);
    if (subagentDispatchGuard) {
      failActivity(subagentDispatchGuard);
      return {
        ...withPermission,
        blocked: true,
        error: subagentDispatchGuard,
      };
    }

    const subagentSideEffectGuard = assessSubagentSideEffectGuard({
      action,
      allowedPermissions: this.allowed,
      permissionPolicy: this.policy.permissionPolicy,
    });
    if (subagentSideEffectGuard) {
      failActivity(subagentSideEffectGuard);
      return {
        ...withPermission,
        blocked: true,
        error: subagentSideEffectGuard,
      };
    }

    const failedActionAssessment = this.failedActionMemory.assess(action);
    if (failedActionAssessment) {
      failActivity(failedActionAssessment.reason);
      const blockedStep: AgentToolStep = {
        ...withPermission,
        blocked: true,
        executed: false,
        recoveryCircuitOpen: failedActionAssessment.circuitOpen,
        error: failedActionAssessment.reason,
      };
      this.failedActionMemory.record(blockedStep);
      return blockedStep;
    }

    const writeOrchestration = orchestrateWorkflowWrite({
      intent: this.getEffectiveIntent(),
      goal: ctx.goal,
      permissionPolicy: this.policy.permissionPolicy,
      tool: action.tool,
      steps: ctx.steps,
      hasProposal: this.workflowProposals.length > 0,
      hasDebugAnalysis: this.workflowDebugAnalyses.length > 0,
      hasRefactorPlan: this.workflowRefactorPlans.length > 0,
    });
    if (writeOrchestration.writePhaseBlocked) {
      const reason = writeOrchestration.blockedReason ?? "workflow write gate blocked";
      failActivity(reason);
      return {
        ...withPermission,
        blocked: true,
        workflowPhaseBlocked: true,
        error: reason,
      };
    }
    if (writeOrchestration.writePhaseRecord) {
      this.workflowWritePhases.push(writeOrchestration.writePhaseRecord);
    }
    if (writeOrchestration.debugFixRecord) {
      this.workflowDebugFixes.push(writeOrchestration.debugFixRecord);
    }
    if (writeOrchestration.pendingWritePhaseContext) {
      this.pendingWritePhaseContext = writeOrchestration.pendingWritePhaseContext;
    }

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

    if (permissionDecision.decision === "deny") {
      const err = permissionDecision.reason ?? permissionDecision.risk.reasons[0] ?? "权限拒绝";
      failActivity(err);
      return {
        ...withPermission,
        blocked: true,
        error: err,
        risk: permissionDecision.risk,
        confirmationRequest: permissionDecision.confirmationRequest,
      };
    }

    // 副作用/高风险工具：需要确认时阻塞（在非交互的循环里更安全）。
    if (permissionDecision.decision === "needsConfirmation") {
      const err =
        permissionDecision.reason ??
        `工具「${tool.name}」需要确认（权限 ${tool.permission}）。未开启自动确认，已跳过。`;
      failActivity(err);
      return {
        ...withPermission,
        blocked: true,
        error: err,
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
      workspaceAccess: pathAccess?.audit,
    });
    const result = await this.toolGateway.invokeRegistry({
      toolName: action.tool,
      input: pathAccess?.input ?? ((action.input ?? {}) as Record<string, unknown>),
      source: ctx.isRecovery ? "agent_loop" : "agent_loop",
      budgetBucket: ctx.isRecovery ? "recovery" : ctx.isPreflight ? "preflight" : "main",
      workspaceRoot: pathAccess?.workspaceRoot ?? this.options.workspaceRoot,
      allowedPermissions: this.allowed,
      scopedGrants: this.resolveScopedGrants(),
      workspaceGrantStore: this.options.workspaceGrantStore,
      workspaceConfigScopes: this.options.workspaceConfigScopes,
      toolCallId,
      taskId: this.options.taskId,
      sessionId: this.options.sessionId,
      requestId: this.options.requestId ?? this.options.runId,
      signal: this.options.signal,
      registryExtras: {
        sensitive: this.options.sensitive,
        subAgentDispatchDepth: this.options.subAgentDispatchDepth ?? 0,
        maxSubAgentDispatchDepth: this.options.maxSubAgentDispatchDepth ?? 1,
        projectAllowedPermissions: this.options.projectAllowedPermissions,
        parentAgentIntent: this.getEffectiveIntent(),
        parentAgentWorkflowType: this.reconciledWorkflowType ?? this.policy.workflowType,
      },
    });

    if (result.executed) {
      const layers = buildToolResultLayers(action.tool, result.output, {
        compact: this.options.contextManager
          ? (t, out) => this.options.contextManager!.compactToolOutput(t, out)
          : undefined,
      });
      const outcome: ToolOutcome = {
        class: result.outcomeClass,
        kind: result.outcomeKind as ToolOutcome["kind"],
        message: result.message,
        recoverable: result.recoverable,
        path: result.outcomePath,
        command: result.outcomeCommand,
        exitCode: result.outcomeExitCode,
        suggestedNextActions: result.suggestedNextActions,
      };
      this.options.trace?.write({
        type: "agent_tool",
        tool: action.tool,
        iteration,
        toolCallId,
        runId: this.options.runId,
        sessionId: this.options.sessionId,
        taskId: this.options.taskId,
        status: traceStatusForOutcome(result.outcomeClass),
        outcomeClass: result.outcomeClass,
        outcomeKind: result.outcomeKind,
        rawJsonLength: layers.rawJsonLength,
        modelJsonLength: layers.modelJsonLength,
        userDisplay: layers.userDisplay,
        rawOutput: layers.raw,
        workspaceAccess: pathAccess?.audit,
      });
      const rawPath = action.input?.path;
      const path = typeof rawPath === "string" ? rawPath : undefined;
      const summary = layers.userDisplay.summary.slice(0, 200) || result.message;
      if (result.outcomeClass === "observation_failure") {
        observeActivity(summary, {
          durationMs: result.durationMs,
          outcomeKind: result.outcomeKind,
          exitCode: result.outcomeExitCode,
          command: result.outcomeCommand,
          workspaceAccess: pathAccess?.audit,
        });
      } else if (result.outcomeClass === "execution_error") {
        failActivity(summary, { durationMs: result.durationMs, outcomeKind: result.outcomeKind, workspaceAccess: pathAccess?.audit });
      } else {
        okActivity(summary, {
          durationMs: result.durationMs,
          changedFiles: path ? [path] : undefined,
          workspaceAccess: pathAccess?.audit,
        });
      }
      const step = applyOutcomeToStep(withPermission, outcome, {
        executed: true,
        output: layers.modelVisible,
        resultLayers: layers,
        durationMs: result.durationMs,
        toolCallId: result.toolCallId,
        risk: result.risk,
        workspaceAccess: pathAccess?.audit,
      });
      if (!ctx.isRecovery && result.output !== undefined) {
        this.toolResultCache.store(action.tool, cacheInputRecord, result.output);
      }
      this.failedActionMemory.record(step);
      return step;
    }
    const errMsg = result.error ?? result.message;
    failActivity(errMsg, { durationMs: result.durationMs, outcomeKind: result.outcomeKind });
    const failedStep = applyOutcomeToStep(
      withPermission,
      {
        class: "execution_error",
        kind: result.outcomeKind as ToolOutcome["kind"],
        message: errMsg,
        recoverable: false,
      },
      {
        executed: false,
        durationMs: result.durationMs,
        toolCallId: result.toolCallId,
        risk: result.risk,
        workspaceAccess: pathAccess?.audit,
      },
    );
    this.failedActionMemory.record(failedStep);
    return failedStep;
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
      executed: false,
      blockedReasonKind: "budget",
      outcomeClass: "execution_error",
      outcomeKind: "budget_exhausted",
      error: `运行预算已耗尽：${budgetExhausted}`,
    };
  }

  private reconcileCapabilityBeforeTool(input: {
    action: ToolAction;
    toolPermission?: ToolPermission;
    workflowRoute: ReturnType<typeof defaultWorkflowRouter.routeIntent>;
    iteration: number;
    messages?: ChatMessage[];
  }): void {
    const escalation = evaluateCapabilityEscalation({
      workflowRoute: input.workflowRoute,
      toolName: input.action.tool,
      toolPermission: input.toolPermission,
    });
    if (!escalation?.canEscalate) return;

    const alreadyRecorded = this.capabilityEscalations.some(
      (e) =>
        e.requestedTool === escalation.requestedTool &&
        e.requestedPermission === escalation.requestedPermission &&
        e.fromWorkflow === escalation.fromWorkflow,
    );
    if (alreadyRecorded) return;

    this.capabilityEscalations.push({
      ...escalation,
      iteration: input.iteration,
      applied: true,
    });
    this.reconciledWorkflowType = escalation.toWorkflow;
    this.reconciledIntent = escalation.toIntent;
    applyEscalationBudget(this.budgetManager, escalation.targetSideEffects);
    this.recordCapabilityEscalationTimeline(escalation, input.action);

    if (input.messages) {
      input.messages.push({
        role: "system",
        content: renderCapabilityEscalationContext(escalation),
      });
    }
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
    return {
      entryIntent: this.entryIntent ?? this.policy.intent,
      entryWorkflowType: this.entryWorkflowType ?? this.policy.workflowType,
      reconciledIntent: this.reconciledIntent,
      reconciledWorkflowType: this.reconciledWorkflowType,
      capabilityEscalations: [...this.capabilityEscalations],
      budgetLedger: this.budgetManager.ledgerSnapshot(),
      failedActionMemoryState: this.failedActionMemory.exportState(),
      toolCacheEntries: this.toolResultCache.exportState(),
    };
  }

  private restoreRuntimeSnapshot(state?: PausedRunRuntimeState): void {
    if (!state) return;
    if (state.entryIntent) this.entryIntent = state.entryIntent;
    if (state.entryWorkflowType) this.entryWorkflowType = state.entryWorkflowType;
    this.reconciledIntent = state.reconciledIntent;
    this.reconciledWorkflowType = state.reconciledWorkflowType;
    this.capabilityEscalations = [...(state.capabilityEscalations ?? [])];
    if (state.failedActionMemoryState?.length) {
      this.failedActionMemory.restoreState(state.failedActionMemoryState);
    }
    if (state.toolCacheEntries?.length) {
      this.toolResultCache.restoreState(state.toolCacheEntries);
    }
    if (state.budgetLedger) {
      this.budgetManager.restoreLedger(state.budgetLedger);
    }
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
    const tool = this.options.registry.get(input.action.tool);
    const workflowRoute = effectiveWorkflowRoute(this.getEffectiveWorkflowContext());
    this.reconcileCapabilityBeforeTool({
      action: input.action,
      toolPermission: tool?.permission,
      workflowRoute,
      iteration: input.iteration,
      messages: input.messages,
    });
    const workflowBlock = assessWorkflowToolAccess({
      mode: this.policy.mode,
      workflowRoute,
      toolPermission: tool?.permission,
    });
    if (workflowBlock.blocked) {
      const step = this.buildWorkflowBlockedStep(
        input.action,
        input.iteration,
        workflowBlock,
        input.toolCallId,
      );
      return { kind: "step", step };
    }

    if (tool) {
      const permissionDecision = evaluatePermissionGuard({
        intent: this.getEffectiveIntent(),
        permissionPolicy: this.policy.permissionPolicy,
        toolName: tool.name,
        permission: tool.permission,
        input: input.action.input ?? {},
        allowedPermissions: this.allowed,
        scopedGrants: this.resolveScopedGrants(),
        shellPolicy: this.options.shellPolicy,
        networkPolicy: this.options.networkPolicy,
      });
      if (permissionDecision.decision === "deny") {
        const step = this.buildPermissionBlockedStep(
          input.action,
          input.iteration,
          permissionDecision.reason ?? "权限拒绝",
          input.toolCallId,
          tool.permission,
        );
        return { kind: "step", step };
      }
      if (permissionDecision.decision === "needsConfirmation" && !input.skipJitPause) {
        const step = await this.runToolAction(input.action, input.iteration, input.toolCallId, {
          steps: input.steps,
          goal: input.goal,
        });
        if (
          step.blocked &&
          step.confirmationRequest?.status === "waiting_confirmation" &&
          this.pauseOnPermissionRequest
        ) {
          const result = await this.pauseForToolPermission({
            step,
            action: input.action,
            messages: input.messages,
            steps: input.steps,
            modelTurns: input.modelTurns,
            goal: input.goal,
            system: input.system,
            sessionId: input.sessionId,
            consumedNotifications: input.consumedNotifications,
          });
          return { kind: "pause", result };
        }
        return { kind: "step", step };
      }
    }

    const pathAccess = this.preparePathAccess(input.action);
    if (pathAccess && !pathAccess.decision.allowed) {
      const step = this.buildPathBlockedStep(
        input.action,
        input.iteration,
        pathAccess,
        input.toolCallId,
      );
      if (
        pathAccess.decision.needsConfirmation &&
        !input.skipJitPause &&
        this.pauseOnPermissionRequest
      ) {
        const result = await this.pauseForToolPermission({
          step,
          action: input.action,
          messages: input.messages,
          steps: [...input.steps, step],
          modelTurns: input.modelTurns,
          goal: input.goal,
          system: input.system,
          sessionId: input.sessionId,
          consumedNotifications: input.consumedNotifications,
        });
        return { kind: "pause", result };
      }
      return { kind: "step", step };
    }

    const toolBudgetExhausted = this.budgetManager.findToolExhaustion({
      toolPermission: tool?.permission,
      permissionAllowed: Boolean(tool),
      steps: input.steps,
    });
    if (toolBudgetExhausted) {
      const step = this.buildBudgetBlockedStep(
        input.action,
        input.iteration,
        toolBudgetExhausted,
        input.toolCallId,
      );
      return {
        kind: "budget",
        result: await this.finishRun({
          answer: "",
          partialSummary: this.buildPartialAnswer(input.steps, toolBudgetExhausted, input.goal),
          steps: input.steps,
          iterations: input.modelTurns,
          reachedLimit: true,
          budgetExhausted: toolBudgetExhausted,
          consumedNotifications: input.consumedNotifications,
          sessionId: input.sessionId,
          userMessage: input.goal,
        }),
      };
    }

    const step = await this.runToolAction(input.action, input.iteration, input.toolCallId, {
      steps: input.steps,
      goal: input.goal,
    });
    return { kind: "step", step };
  }

  private recordCapabilityEscalationTimeline(
    escalation: CapabilityEscalation,
    action: ToolAction,
  ): void {
    const tl = this.options.timeline;
    const runId = this.options.runId;
    if (!tl || !runId) return;
    const targetPath = (action.input as { path?: string } | undefined)?.path;
    const autoApproved =
      this.policy.permissionPolicy === "autoRun" || this.policy.permissionPolicy === "autoEdit";
    tl.recordCapabilityEscalation({
      runId,
      title: `能力升级：${escalation.fromWorkflow} → ${escalation.toWorkflow}`,
      content: formatCapabilityEscalationTimelineContent({
        escalation: { ...escalation, iteration: 0, applied: true },
        permissionPolicy: this.policy.permissionPolicy,
        targetPath,
        autoApproved,
      }),
      metadata: {
        toolName: escalation.requestedTool,
        filePath: targetPath,
      },
    });
  }

  private buildWorkflowBlockedStep(
    action: ToolAction,
    iteration: number,
    block: WorkflowCapabilityAssessment,
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
      executed: false,
      blockedReasonKind: "workflow",
      outcomeClass: "execution_error",
      outcomeKind: block.outcomeKind ?? "policy_blocked",
      error: block.reason,
    };
  }

  private buildPermissionBlockedStep(
    action: ToolAction,
    iteration: number,
    reason: string,
    toolCallId: string | undefined,
    permission: ToolPermission | undefined,
  ): AgentToolStep {
    return {
      iteration,
      toolCallId,
      tool: action.tool,
      input: action.input ?? {},
      permission,
      thought: action.thought,
      ok: false,
      blocked: true,
      executed: false,
      blockedReasonKind: "permission",
      outcomeClass: "execution_error",
      outcomeKind: "permission_denied",
      error: reason,
    };
  }

  private renderToolResult(step: AgentToolStep, steps?: AgentToolStep[]): string {
    if (step.blocked) {
      return renderBlockedRecoveryMessage(step);
    }
    if (step.outcomeClass === "observation_failure") {
      const observationText = renderToolOutcomeMessage(step);
      if (observationText) return observationText;
    }
    if (!step.ok) {
      if (step.outcomeClass === "execution_error") {
        return renderExecutionErrorMessage(step);
      }
      if (step.tool === DISPATCH_SUBAGENT_TOOL_NAME) {
        return renderDispatchSubagentFailure(step);
      }
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
    const base = `工具「${step.tool}」执行结果（JSON）：\n${body}`;
    if (step.tool === DISPATCH_SUBAGENT_TOOL_NAME && steps) {
      return renderSubagentFinalConvergencePrompt(base, steps);
    }
    return base;
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
    const usage = this.budgetManager.buildUsage(input.steps, input.iterations);
    const needsMoreBudget = input.stopReason === "budget_exhausted";
    const location = buildLocationMeta(input.steps);
    const workflowDiffs = buildWorkflowDiffs(input.steps);
    const workflowVerifications = buildWorkflowVerifications(this.getEffectiveIntent(), input.steps);
    const workflowCorrections = buildWorkflowCorrections(this.getEffectiveIntent(), input.steps);
    const workflowState = buildWorkflowState({
      intent: this.getEffectiveIntent(),
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
    const ledger = buildToolLedger(input.steps);
    const base: AgentExecutionMeta = {
      mode: this.policy.mode,
      executionStage: this.policy.executionStage,
      modeSource: this.policy.modeSource,
      intent: this.getEffectiveIntent(),
      workflowType: this.reconciledWorkflowType ?? this.policy.workflowType,
      permissionPolicy: this.policy.permissionPolicy,
      permissionPolicySource: this.policy.permissionPolicySource,
      intentDecisionSource: this.policy.intentDecisionSource,
      isContinuation: this.policy.isContinuation,
      intentDecisionReason: this.policy.intentDecisionReason,
      intentDecisionConfidence: this.policy.intentDecisionConfidence,
      inheritedTaskId: this.policy.inheritedTaskId,
      previousWorkflowType: this.policy.previousWorkflowType,
      currentWorkflowType: this.reconciledWorkflowType ?? this.policy.workflowType,
      continuationScore: this.policy.continuationScore,
      continuationSignals: this.policy.continuationSignals,
      needsWrite: this.policy.needsWrite,
      needsShell: this.policy.needsShell,
      aiOverridden: this.policy.aiOverridden,
      boundaryBreakReason: this.policy.boundaryBreakReason,
      effectiveTaskContextId: this.policy.effectiveTaskContextId,
      legacyIntentHint: this.policy.legacyIntentHint,
      legacyHintSources: this.policy.legacyHintSources,
      entryIntent: this.entryIntent ?? this.policy.entryIntent,
      entryWorkflowType: this.entryWorkflowType ?? this.policy.entryWorkflowType,
      effectiveWorkflowType: this.reconciledWorkflowType ?? this.policy.effectiveWorkflowType,
      workflowProposals: this.workflowProposals.length ? this.workflowProposals : undefined,
      workflowDebugAnalyses: this.workflowDebugAnalyses.length ? this.workflowDebugAnalyses : undefined,
      workflowRefactorPlans: this.workflowRefactorPlans.length ? this.workflowRefactorPlans : undefined,
      workflowInternalPlans: this.workflowInternalPlans.length ? this.workflowInternalPlans : undefined,
      workflowTaskState,
      workflowSwitch: this.workflowSwitch,
      capabilityEscalations: this.capabilityEscalations.length ? this.capabilityEscalations : undefined,
      reconciledWorkflowType: this.reconciledWorkflowType,
      reconciledIntent: this.reconciledIntent,
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
      completionStatus: input.completionGuard?.status,
      completionGuardReason: input.completionGuard?.reason,
      guardedAnswer: input.completionGuard?.guardedAnswer,
      rawModelAnswer: input.completionGuard?.rawModelAnswer,
      partialSummary: input.partialSummary,
      toolLedger: toolLedgerToSummary(ledger),
      toolLedgerSummary: toolLedgerToSummary(ledger),
      suggestedBudget: needsMoreBudget && input.budgetExhausted
        ? this.budgetManager.buildSuggestedBudget(input.budgetExhausted)
        : undefined,
    };
    const presentation = presentExecutionState(base);
    base.userFacingState = presentation.userFacingState;
    base.userFacingLabel = presentation.userFacingLabel;
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
      location: buildLocationMeta(steps),
    });
  }

  private createPermissionRequestFromStep(step: AgentToolStep): PermissionRequestPayload {
    const confirmation = step.confirmationRequest!;
    const requiredPermissions = permissionItemsFromConfirmation(confirmation);
    return this.permissionRequestStore.create({
      runId: this.options.runId ?? "unknown-run",
      sessionId: this.options.sessionId,
      title: confirmation.title,
      summary: confirmation.message,
      requiredPermissions,
      intent: this.getEffectiveIntent(),
      executionStage: this.policy.executionStage,
      planVariant: this.policy.planVariant,
      blockedTool: {
        name: step.tool,
        input: step.input as Record<string, unknown> | undefined,
      },
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
    this.pausedRunStore.save({
      runId: this.options.runId ?? "unknown-run",
      sessionId: input.sessionId,
      goal: input.goal,
      system: input.system,
      messages: input.messages.map((m) => ({ ...m })),
      steps: [...input.steps],
      workflowProposals: [...(input.workflowProposals ?? this.workflowProposals)],
      workflowDebugAnalyses: [...(input.workflowDebugAnalyses ?? this.workflowDebugAnalyses)],
      workflowRefactorPlans: [...(input.workflowRefactorPlans ?? this.workflowRefactorPlans)],
      workflowInternalPlans: [...(input.workflowInternalPlans ?? this.workflowInternalPlans)],
      modelTurns: input.modelTurns,
      pendingAction: input.pendingAction,
      mode: this.policy.mode,
      permissionPolicy: this.policy.permissionPolicy,
      resumeMode: input.resumeMode,
      runtimeState: this.buildRuntimeSnapshot(),
      createdAt: new Date().toISOString(),
    });
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
    const inputTokens = sumOptional(this.modelTurnMetrics.map((m) => m.inputTokens));
    const outputTokens = sumOptional(this.modelTurnMetrics.map((m) => m.outputTokens));
    const costUsd = sumOptional(this.modelTurnMetrics.map((m) => m.costUsd));
    const modelLatencyMs = this.modelTurnMetrics.reduce((sum, m) => sum + m.latencyMs, 0);
    const modelErrors = this.modelTurnMetrics.filter((m) => !m.success);
    const outcomeUsage = countToolOutcomeUsage(steps);
    const failedTools = steps.filter((s) => isFailedToolStep(s));
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
      toolFailures: outcomeUsage.toolFailures,
      toolObservationFailures: outcomeUsage.toolObservationFailures,
      toolExecutionErrors: outcomeUsage.toolExecutionErrors,
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
        status: stepPlanTraceStatus(step),
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

/** 将安全点消费的通知格式化为可回灌给模型的系统运行态消息。 */
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

/** 去掉思考块噪声；Markdown 围栏可能出现在 final.answer 中，不能在解析前剥离。 */
export function stripModelNoise(content: string): string {
  let s = content;
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/<redacted_reasoning>[\s\S]*?<\/redacted_reasoning>/gi, "");
  return s.trim();
}

/** 从模型输出中提取可执行动作；final.answer 内部允许包含 Markdown/JSON 代码块。 */
export function parseAction(content: string): AgentAction | null {
  const cleaned = stripModelNoise(content);
  const direct = parseActionJson(cleaned);
  if (direct) return direct;
  for (const obj of extractJsonObjects(cleaned)) {
    const action = parseActionJson(obj);
    if (action) return action;
  }
  return null;
}

function parseActionJson(json: string): AgentAction | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed === "string" && parsed !== json) {
    return parseAction(parsed);
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

/** 扫描出所有平衡的 {...} 候选（忽略字符串内的花括号）。 */
function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    }
    else if (ch === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}
