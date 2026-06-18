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
import { EditAutoVerificationWorkflow } from "./EditAutoVerificationWorkflow.js";
import { EditProposalWorkflow } from "./EditProposalWorkflow.js";
import { MAX_WORKFLOW_CORRECTION_ATTEMPTS, WorkflowCorrectionWorkflow } from "./WorkflowCorrectionWorkflow.js";
import { hasPlanningPhaseArtifacts, resolveWorkflowTaskState } from "./WorkflowTaskState.js";
import { WorkflowExecutor } from "./WorkflowExecutor.js";
import {
  defaultWorkflowSessionStore,
  renderWorkflowSwitchContext,
  resolveWorkflowSwitch,
} from "./WorkflowSessionSwitch.js";
import { buildWorkflowState } from "./WorkflowStateCenter.js";
import { orchestrateWorkflowWrite } from "./workflowWriteOrchestrator.js";
import { buildWorkflowFollowupContexts } from "./workflowFollowupContexts.js";
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
import type { AgentToolStep } from "./toolStep.js";
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

const ENOUGH_SUBAGENT_RESULTS_FOR_FINAL = 3;

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
  /** 固定 JSON 权限申请（通用弹窗 / API）。 */
  permissionRequest?: PermissionRequestPayload;
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
  /** 会话级已批准作用域权限。 */
  sessionPermissionGrants?: SessionPermissionGrants;
  /** 本轮一次性已批准作用域权限。 */
  scopedGrants?: ScopedApprovedPermissions;
  /** 暂停 Run 快照存储（HTTP 入口注入单例），用于权限暂停后的忠实续跑。 */
  pausedRunStore?: PausedRunStore;
  /** 恢复执行：从该快照忠实续跑同一段对话（执行被批准工具或按计划进入执行阶段）。 */
  pausedRun?: PausedRunSnapshot;
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
  private pendingWritePhaseContext?: string;

  constructor(private readonly options: AgentLoopOptions) {
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
    this.scopedGrants = options.scopedGrants;
    this.permissionRequestStore = options.permissionRequestStore ?? defaultPermissionRequestStore;
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
      write_file: [...new Set([...(this.scopedGrants?.write_file ?? []), ...(sessionGrants?.write_file ?? [])])],
      shell: [...new Set([...(this.scopedGrants?.shell ?? []), ...(sessionGrants?.shell ?? [])])],
      delete_file: [...new Set([...(this.scopedGrants?.delete_file ?? []), ...(sessionGrants?.delete_file ?? [])])],
      network: [...new Set([...(this.scopedGrants?.network ?? []), ...(sessionGrants?.network ?? [])])],
      dangerous: [...new Set([...(this.scopedGrants?.dangerous ?? []), ...(sessionGrants?.dangerous ?? [])])],
    };
  }

  private get budget(): RunBudget {
    return this.budgetManager.budget;
  }

  private restoreApprovedHandoffArtifacts(pausedRun: PausedRunSnapshot): void {
    if (!pausedRun.resumeMode || this.workflowProposals.length > 0) return;
    const result = new EditProposalWorkflow().run({
      goal: pausedRun.goal,
      intent: this.policy.intent,
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
    this.pendingWritePhaseContext = undefined;
    const pausedRun = this.options.pausedRun;
    if (pausedRun) {
      this.workflowProposals = [...(pausedRun.workflowProposals ?? [])];
      this.workflowDebugAnalyses = [...(pausedRun.workflowDebugAnalyses ?? [])];
      this.workflowRefactorPlans = [...(pausedRun.workflowRefactorPlans ?? [])];
      this.workflowInternalPlans = [...(pausedRun.workflowInternalPlans ?? [])];
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
      ctx.saveUserMessage(sessionId, userMessage);
    }

    // 续跑：直接复用暂停时的对话快照，忠实从同一段对话继续（不重建上下文、不重跑预扫描工作流）。
    const messages: ChatMessage[] = pausedRun
      ? [...pausedRun.messages]
      : ctx && sessionId
        ? ctx.buildChatMessages(
            await ctx.restoreContextPackage(sessionId, effectiveGoal),
            this.buildSystemPrompt(system),
            { phase: "pre_call", currentUser: isResume ? "继续上次计划扫描" : effectiveGoal },
          )
        : [
            { role: "system", content: this.buildSystemPrompt(system) },
            { role: "user", content: effectiveGoal },
          ];

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

    if (!pausedRun && sessionId && !isResume && this.policy.intent && this.policy.workflowType) {
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
      for (const modelContext of workflowResult.modelContexts) {
        messages.push({ role: "user", content: modelContext });
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
        const executionSystemPrompt = this.buildSystemPrompt(pausedRun.system);
        if (messages[0]?.role === "system") {
          messages[0] = { role: "system", content: executionSystemPrompt };
        } else {
          messages.unshift({ role: "system", content: executionSystemPrompt });
        }
      }
      // 注入一条最小的执行指令（非“假装用户说继续”，而是明确的阶段切换信号）。
      messages.push({
        role: "user",
        content:
          "（系统）用户已批准执行。请立即按上文计划进入执行阶段，调用真实工具（write_file / apply_patch / shell_run）完成修改与验证，不要只复述计划或再次询问是否继续。",
      });
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
      if (ctx && sessionId) {
        ctx.saveAssistantMessage(sessionId, response.content);
      }

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
          role: "user",
          content:
            '上一条不是合法的 JSON。请只输出一个 JSON 对象：{"action":"tool",...} 或 {"action":"final","answer":"..."}。禁止把 JSON 放进字符串（错误示例："{"action":"final",...}"）。',
        });
        continue;
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
          answerLength: action.answer.length,
        });
        // 计划→执行交接：计划已产出（只读阶段），冻结对话快照并申请执行批准。
        // 批准后由 resumeAfterPermission 用该快照在 implement 模式下忠实续跑，无需正则猜权限或合成续跑消息。
        if (!pausedRun && this.shouldHandoffAfterPlan() && action.answer.trim()) {
          const permissionRequest = this.permissionRequestStore.create({
            runId: this.options.runId ?? "unknown-run",
            sessionId,
            title: "AI 已完成计划，是否批准执行？",
            summary: "批准后将进入执行阶段，按计划调用真实工具完成修改与验证。",
            requiredPermissions: [
              { type: "write_file", target: "计划涉及的文件", reason: "按已批准计划执行修改与验证" },
            ],
            planMarkdown: action.answer,
            intent: this.policy.intent,
            executionStage: this.policy.executionStage,
            planVariant: this.policy.planVariant,
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
          return await this.finishRun({
            answer: `${action.answer}\n\n---\n\n**等待执行批准**：在侧栏权限弹窗选择「允许」「拒绝」或「本次会话都允许」，批准后将自动按计划执行。`,
            steps,
            iterations: iteration,
            reachedLimit: false,
            consumedNotifications,
            sessionId,
            userMessage: effectiveGoal,
            stopReason: "awaiting_permission",
            permissionRequest,
            awaitingPermission: true,
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
      if (
        step.blocked &&
        step.confirmationRequest?.status === "waiting_confirmation" &&
        this.pauseOnPermissionRequest
      ) {
        return await this.pauseForToolPermission({
          step,
          action,
          messages,
          steps,
          modelTurns,
          goal: effectiveGoal,
          system,
          sessionId,
          consumedNotifications,
        });
      }
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
    } catch (err) {
      if (this.isCancelledError(err)) {
        return await this.finishRun({
          answer: "（运行已取消）",
          steps,
          iterations: modelTurns,
          reachedLimit: false,
          consumedNotifications,
          sessionId,
          userMessage: effectiveGoal,
          stopReason: "user_cancelled",
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
    awaitingPermission?: boolean;
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
      stopReason: input.stopReason ?? (input.reachedLimit ? "budget_exhausted" : "completed"),
      budgetExhausted: input.budgetExhausted,
      goal: input.userMessage,
    });
    executionMeta.planVariant = this.policy.planVariant;
    this.writeRunUsageSummary(input.steps, executionMeta);

    // 计划→执行的权限申请已在 run() 的 final 分支按对话快照就地处理（不再用正则从计划文本猜权限）。
    const permissionRequest = input.permissionRequest;
    const awaitingPermission = input.awaitingPermission === true;
    const answer = input.answer;

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

    this.finalizeActivityTimeline(input);

    return {
      answer,
      steps: input.steps,
      iterations: input.iterations,
      reachedLimit: input.reachedLimit,
      awaitingPermission,
      permissionRequest,
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

  private recordToolStepMessages(input: {
    messages: ChatMessage[];
    step: AgentToolStep;
    steps: AgentToolStep[];
    goal: string;
    sessionId?: string;
  }): void {
    const toolText = this.renderToolResult(input.step, input.steps);
    input.messages.push({ role: "user", content: toolText });
    const followups = buildWorkflowFollowupContexts({
      intent: this.policy.intent,
      goal: input.goal,
      step: input.step,
      steps: input.steps,
      pendingWritePhaseContext: this.pendingWritePhaseContext,
    });
    this.pendingWritePhaseContext = followups.pendingWritePhaseContext;
    for (const extra of [
      followups.blockedContext,
      followups.writePhaseContext,
      followups.editExecutionContext,
      followups.editVerificationContext,
      followups.workflowCorrectionContext,
    ]) {
      if (extra) input.messages.push({ role: "user", content: extra });
    }
    const ctx = this.options.contextManager;
    if (ctx && input.sessionId) {
      ctx.saveToolMessage(input.sessionId, toolText);
      for (const extra of [
        followups.blockedContext,
        followups.writePhaseContext,
        followups.editExecutionContext,
        followups.editVerificationContext,
        followups.workflowCorrectionContext,
      ]) {
        if (extra) ctx.saveToolMessage(input.sessionId, extra);
      }
    }
  }

  private finalizeActivityTimeline(input: {
    answer: string;
    reachedLimit: boolean;
    budgetExhausted?: RunBudgetKey;
    stopReason?: AgentStopReason;
  }): void {
    const tl = this.options.timeline;
    if (!tl) return;
    const runId = this.options.runId ?? tl.getRun()?.id ?? "";
    const stop = input.stopReason ?? (input.reachedLimit ? "budget_exhausted" : "completed");
    if (stop === "user_cancelled") {
      tl.cancelRun("用户取消");
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
      tl.failRun(`运行预算耗尽：${input.budgetExhausted ?? "unknown"}`);
      return;
    }
    tl.completeRun(input.answer.slice(0, 800));
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
    const failActivity = (msg: string, extra?: { durationMs?: number }) => {
      if (activityStepId && tl) {
        tl.failStep(activityStepId, msg, { durationMs: extra?.durationMs });
      }
    };
    const okActivity = (msg: string, extra?: { durationMs?: number; changedFiles?: string[] }) => {
      if (activityStepId && tl) {
        tl.completeStep(activityStepId, msg, {
          durationMs: extra?.durationMs,
          resultSummary: msg,
          changedFiles: extra?.changedFiles,
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

    const subagentDispatchGuard = this.assessSubagentDispatchGuard(action, ctx.steps);
    if (subagentDispatchGuard) {
      failActivity(subagentDispatchGuard);
      return {
        ...withPermission,
        blocked: true,
        error: subagentDispatchGuard,
      };
    }

    const subagentSideEffectGuard = this.assessSubagentSideEffectGuard(action);
    if (subagentSideEffectGuard) {
      failActivity(subagentSideEffectGuard);
      return {
        ...withPermission,
        blocked: true,
        error: subagentSideEffectGuard,
      };
    }

    const writeOrchestration = orchestrateWorkflowWrite({
      intent: this.policy.intent ?? "answer",
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
      intent: this.policy.intent,
      permissionPolicy: this.policy.permissionPolicy,
      toolName: tool.name,
      permission: tool.permission,
      input: action.input ?? {},
      allowedPermissions: this.allowed,
      scopedGrants: this.resolveScopedGrants(),
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
    });
    const result = await this.options.registry.run(action.tool, action.input ?? {}, {
      workspaceRoot: this.options.workspaceRoot,
      allowedPermissions: this.allowed,
      taskId: this.options.taskId,
      sessionId: this.options.sessionId,
      requestId: this.options.requestId ?? this.options.runId,
      toolCallId,
      sensitive: this.options.sensitive,
      subAgentDispatchDepth: this.options.subAgentDispatchDepth ?? 0,
      maxSubAgentDispatchDepth: this.options.maxSubAgentDispatchDepth ?? 1,
      projectAllowedPermissions: this.options.projectAllowedPermissions,
      signal: this.options.signal,
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
      const rawPath = action.input?.path;
      const path = typeof rawPath === "string" ? rawPath : undefined;
      okActivity(layers.userDisplay.summary.slice(0, 200) || "执行成功", {
        durationMs: result.durationMs,
        changedFiles: path ? [path] : undefined,
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
    const errMsg = `[${result.code}] ${result.error}`;
    failActivity(errMsg, { durationMs: result.durationMs });
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

  private renderToolResult(step: AgentToolStep, steps?: AgentToolStep[]): string {
    if (step.blocked) {
      return `工具「${step.tool}」未执行：${step.error}。请改用其它只读工具，或直接给出 final 答案。`;
    }
    if (!step.ok) {
      if (step.tool === DISPATCH_SUBAGENT_TOOL_NAME) {
        return this.renderDispatchSubagentFailure(step);
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
      const successfulDispatches = this.countSuccessfulSubagentDispatches(steps);
      if (successfulDispatches >= ENOUGH_SUBAGENT_RESULTS_FOR_FINAL) {
        return [
          base,
          "",
          `已收集 ${successfulDispatches} 个子 Agent 结果，足以完成用户要求。下一步必须汇总这些结果并输出 final，不要继续调用 dispatch_subagent。`,
        ].join("\n");
      }
    }
    return base;
  }

  private assessSubagentDispatchGuard(action: ToolAction, steps: AgentToolStep[]): string | undefined {
    if (action.tool !== DISPATCH_SUBAGENT_TOOL_NAME) return undefined;
    const successfulDispatches = this.countSuccessfulSubagentDispatches(steps);
    if (successfulDispatches < ENOUGH_SUBAGENT_RESULTS_FOR_FINAL) return undefined;
    return `已完成 ${successfulDispatches} 次 dispatch_subagent 并取得足够子 Agent 结果；请直接汇总已有结果并输出 final，不要继续派生子 Agent。`;
  }

  /**
   * 写/命令型子任务的派生须受父运行权限与确认策略双重约束：
   * - 权限上限：子任务请求的 write/shell 必须在当前运行的有效权限内（不能由模型自行突破）；
   * - 确认门：非交互循环中，写需 autoEdit/autoRun、命令需 autoRun，否则按「需确认」阻塞。
   * 这弥补了 dispatch_subagent 声明为 read 级、绕过 PermissionGuard 副作用确认的缺口。
   */
  private assessSubagentSideEffectGuard(action: ToolAction): string | undefined {
    if (action.tool !== DISPATCH_SUBAGENT_TOOL_NAME) return undefined;
    const input = action.input as { tasks?: unknown } | undefined;
    const tasks = Array.isArray(input?.tasks) ? (input!.tasks as unknown[]) : [];
    const readPolicyFlag = (task: unknown, key: "writeAllowed" | "shellAllowed"): boolean => {
      if (!task || typeof task !== "object") return false;
      const policy = (task as { toolPolicy?: unknown }).toolPolicy;
      if (!policy || typeof policy !== "object") return false;
      return (policy as Record<string, unknown>)[key] === true;
    };
    const wantsWrite = tasks.some((t) => readPolicyFlag(t, "writeAllowed"));
    const wantsShell = tasks.some((t) => readPolicyFlag(t, "shellAllowed"));
    if (!wantsWrite && !wantsShell) return undefined;

    if (wantsWrite && !this.allowed.includes("write")) {
      return "子任务请求写权限，但当前运行未授予 write，已阻止派生。请改为只读子任务，或在授予写权限后重试。";
    }
    if (wantsShell && !this.allowed.includes("shell")) {
      return "子任务请求 shell 权限，但当前运行未授予 shell，已阻止派生。请改为只读子任务，或在授予 shell 权限后重试。";
    }

    const policy = this.policy.permissionPolicy;
    const autoForWrite = policy === "autoEdit" || policy === "autoRun";
    const autoForShell = policy === "autoRun";
    if (wantsWrite && !autoForWrite) {
      return "派生写文件子 Agent 需要用户确认（当前权限策略非自动）。已阻止；请在确认/自动模式下重试。";
    }
    if (wantsShell && !autoForShell) {
      return "派生执行命令子 Agent 需要用户确认（当前权限策略非自动）。已阻止；请在确认/自动模式下重试。";
    }
    return undefined;
  }

  private countSuccessfulSubagentDispatches(steps: AgentToolStep[]): number {
    return steps.filter((step) => step.tool === DISPATCH_SUBAGENT_TOOL_NAME && step.ok).length;
  }

  private renderDispatchSubagentFailure(step: AgentToolStep): string {
    const error = step.error ?? "未知错误";
    if (error.includes("invalid_input")) {
      return [
        `工具「${step.tool}」执行失败：${error}。`,
        "dispatch_subagent 参数须为 tasks: DelegatedTask[]，每项含 goal；写操作须 toolPolicy.writeAllowed 且 grantedPermissions 含 write。",
        "不要使用 roles/role/task 字符串，也不要使用 patch_worker/code_review/test_analyze 等固定角色；需要多个子 Agent 时请传多个 tasks。",
        "如果已经拿到足够子 Agent 结论，请直接输出 final。",
      ].join("\n");
    }
    if (error.includes("grantedPermissions 须包含 write")) {
      return [
        `工具「${step.tool}」执行失败：${error}。`,
        "写权限子任务须 toolPolicy.writeAllowed=true 且 grantedPermissions 含 write。若只是分析，请设置 writeAllowed=false。",
      ].join("\n");
    }
    return `工具「${step.tool}」执行失败：${error}。请修正 tasks 参数后再决定下一步；如果已有足够结果，请直接输出 final。`;
  }

  private buildSystemPrompt(extra?: string): string {
    const specs = this.options.registry
      .list()
      .filter((t) => this.allowed.includes(t.permission) && this.isToolExposedToModel(t.name))
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
      '1.1 严禁把 JSON 对象再包成字符串（错误："{\\"action\\":\\"final\\"...}"）。必须直接输出对象本体（正确：{"action":"final","answer":"..."}）。',
      '2. 需要使用工具时输出：{"action":"tool","tool":"工具名","input":{参数},"thought":"简述原因"}',
      '3. 已能回答用户时输出：{"action":"final","answer":"给用户的最终中文回答"}',
      "4. 一次只能调用一个工具；根据工具返回结果再决定下一步。",
      "5. 不要臆测文件内容或命令输出，先用工具查看再下结论。",
      "6. tool 字段只能填写上方“可用工具”列表中逐字出现的工具名；不要调用内部流程名或编排类名。",
      "7. 大任务可拆成若干可独立推进的小步骤时，使用 dispatch_subagent；子 Agent 是独立任务执行单元，接收目标、约束、最小上下文和可用工具，独立分析/搜索/编辑/验证，并以结构化结果返回，由你判断采纳并汇总。",
      "8. dispatch_subagent 只能传 tasks: DelegatedTask[]，不要传 roles、role、task 字符串或 patch_worker/code_review/test_analyze 之类固定角色。用户明确要求 N 个子 Agent 时，优先一次传入 N 个独立 tasks，每个 task 都要有不同 goal/instructions。",
      "9. 非工程/非文件任务的子 Agent 默认不要读取项目文件，toolPolicy.allowedTools 可设为空数组或只读工具；只有用户任务明确涉及当前项目、代码、文件、测试或命令时，才使用 locate_relevant_files/context_pack/read_file 等项目工具。",
      "10. 需要查找相关文件时，优先使用 project_scan / symbol_search / locate_relevant_files / context_pack；写入文件后可用 project_index_update 增量刷新索引；避免连续用 list_files、search_text、read_file 逐个试探。",
      "11. 已知类名/函数名时优先 symbol_search；locate_relevant_files 已返回 primaryFiles 时，优先用 context_pack 打包这些文件，再分析或修改。",
      this.policy.systemHint,
      extra ? `\n补充要求：${extra}` : "",
    ].join("\n");
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
  }): AgentExecutionMeta {
    const usage = this.budgetManager.buildUsage(input.steps, input.iterations);
    const needsMoreBudget = input.stopReason === "budget_exhausted";
    const location = buildLocationMeta(input.steps);
    const workflowDiffs = buildWorkflowDiffs(input.steps);
    const workflowVerifications = buildWorkflowVerifications(this.policy.intent, input.steps);
    const workflowCorrections = buildWorkflowCorrections(this.policy.intent, input.steps);
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
      executionStage: this.policy.executionStage,
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
      intent: this.policy.intent,
      executionStage: this.policy.executionStage,
      planVariant: this.policy.planVariant,
      blockedTool: {
        name: step.tool,
        input: step.input as Record<string, unknown> | undefined,
      },
    });
  }

  /** 计划阶段是否需要在产出计划后申请执行批准（plan_wait_approval / plan_then_execute）。 */
  private shouldHandoffAfterPlan(): boolean {
    return (
      this.policy.intent === "plan" &&
      (this.policy.afterPlan === "request_permission" ||
        this.policy.afterPlan === "request_permission_then_execute")
    );
  }

  /** 冻结当前对话快照，供权限批准后忠实续跑。 */
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
      answer: "等待权限确认后继续执行。",
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
    const step = await this.runToolAction(action, iteration, toolCallId, {
      steps: input.steps,
      goal: input.goal,
    });
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
