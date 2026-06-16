import { Planner } from "../agent/Planner.js";

import {
  AgentLoop,
  type AgentRunResult,
  type LoopChatFn,
} from "../agent/AgentLoop.js";
import type { AgentToolStep } from "../agent/toolStep.js";
import { AgentTimelineService } from "../agent/timeline/AgentTimelineService.js";
import type { AgentActivityEvent } from "../agent/timeline/types.js";
import { ActivityRunStore } from "../agent/timeline/ActivityRunStore.js";
import { defaultActivityEventBus } from "../agent/timeline/AgentEventBus.js";
import type { AgentStreamEvent } from "./AgentStream.js";
import type { ChatStreamEvent } from "./ChatStream.js";

import { planFromTask } from "../agent/planFromTask.js";
import { TaskExecutionWorkflow } from "../agent/TaskExecutionWorkflow.js";
import { finalizePlan } from "../agent/taskGraph.js";
import { aggregateTaskStatus } from "../agent/taskStatus.js";
import { PlanSchema, type Plan } from "../agent/types.js";
import { defaultRunPolicyManager } from "../agent/RunPolicy.js";
import type { RunBudget } from "../agent/RunPolicyTypes.js";

import type { NotificationQueue } from "../background/NotificationQueue.js";

import type { ContextManager } from "../context/ContextManager.js";

import type { TaskStore } from "../context/stores.js";
import type { TaskRecord } from "../context/types.js";

import type { CorrelationContext } from "../core/correlation.js";

import type { ModelOrchestrator } from "../model-orchestrator/index.js";
import type { ModelRouter } from "../model/ModelRouter.js";
import type { SmartModelRouter } from "../model-router/smart-model-router.js";
import { parseModelTaskTypeOrError } from "../model/taskType.js";
import { detectPlanReportRequest } from "../plan/planIntent.js";
import { legacyPlanFromInternal } from "../plan/planConverter.js";
import type { PlanService } from "../plan/PlanService.js";
import { PlanValidationError } from "../plan/types.js";

import type { ToolPermission } from "../agent/permissions.js";

import type { SubAgentCoordinator } from "../subagent/SubAgentCoordinator.js";


import type { ToolRegistry } from "../tools/ToolRegistry.js";

import type { TraceLogger } from "../trace/TraceLogger.js";

import { ChatService } from "./ChatService.js";
import { RunStore } from "./RunStore.js";
import { RunStateStore } from "./RunStateStore.js";
import { AgentRunRegistry } from "./AgentRunRegistry.js";
import type { ProjectIndex } from "../context/ProjectIndex.js";
import type { RunState } from "./runStateTypes.js";
import { rollbackFileChangesForRun, type TaskRollbackResult } from "./TaskRollback.js";
import {
  buildPlanFallbackContext,
  detectTaskUncertainty,
  type ModeFallbackResult,
} from "./taskUncertainty.js";



export interface OrchestratorDeps {

  workspaceRoot: string;

  modelRouter: ModelRouter;

  planner: Planner;

  registry: ToolRegistry;

  contextManager: ContextManager;

  tasks: TaskStore;

  runs: RunStore;

  runStateStore: RunStateStore;

  projectIndex?: ProjectIndex;

  notificationQueue: NotificationQueue;

  trace?: TraceLogger;

  makeChatFn: (forceClient?: string) => LoopChatFn;

  subAgentCoordinator?: SubAgentCoordinator;

  subAgentCoordinatorFor?: (forceClient?: string) => SubAgentCoordinator;

  smartModelRouter?: SmartModelRouter;

  modelOrchestrator?: ModelOrchestrator;

  planService: PlanService;

  /** 单次 Agent Run 费用上限（USD），来自 security.budget.maxCostUsdPerRun。 */
  maxCostUsdPerRun?: number;

  /** 项目级权限上限，来自 config.security.permissions。 */
  projectAllowedPermissions: ToolPermission[];

  /** 子 Agent 最大派生深度（security.subagent.maxDispatchDepth），默认 1。 */
  maxSubAgentDispatchDepth?: number;

  /** 流式 Agent / Chat Run 取消注册表。 */
  agentRunRegistry: AgentRunRegistry;

}



export type ApiResult = { status: number; body: unknown };



/**

 * 统一编排层：Agent / Task / Chat / Plan 均创建 Run 记录并写入关联 id。

 * 后续 DAG、调度自动执行、流式推送均在此扩展，避免 server handler 膨胀。

 */

export class Orchestrator {

  private readonly chatService: ChatService;

  constructor(private readonly deps: OrchestratorDeps) {
    this.chatService = new ChatService({
      runs: deps.runs,
      contextManager: deps.contextManager,
      modelRouter: deps.modelRouter,
      smartModelRouter: deps.smartModelRouter,
      modelOrchestrator: deps.modelOrchestrator,
      agentRunRegistry: deps.agentRunRegistry,
      trace: deps.trace,
    });
  }



  ensureSession(sessionId: string | undefined, title: string): string {

    if (sessionId && this.deps.contextManager.getSession(sessionId)) return sessionId;

    return this.deps.contextManager.createSession(title).id;

  }



  listRuns(limit?: number) {

    return this.deps.runs.list({ limit: limit ?? 50 });

  }



  getRun(id: string) {

    return this.deps.runs.get(id);

  }



  async runChat(body: unknown): Promise<ApiResult> {
    return this.chatService.runChat(body);
  }




  /** SSE：单次对话流式（token + done）；委派给 ChatService（走 ModelRouter 以支持 onToken）。 */
  async runChatStream(body: unknown, emit: (event: ChatStreamEvent) => void): Promise<void> {
    return this.chatService.runChatStream(body, emit);
  }



  async generatePlan(body: unknown, planner?: Planner): Promise<ApiResult> {

    const payload = (body ?? {}) as { goal?: string; context?: string; clientName?: string };

    const goal = (payload.goal ?? "").trim();

    if (!goal) return { status: 400, body: { error: "goal 不能为空" } };

    const reportRequest = detectPlanReportRequest(goal);
    if (reportRequest) return { status: 400, body: reportRequest };



    const run = this.deps.runs.create({

      kind: "plan",

      status: "running",

      goal,

      correlation: { runId: "" },

    });

    this.deps.runs.update(run.id, {

      correlationJson: JSON.stringify(this.correlationFor(run.id, {})),

    });



    try {

      this.deps.trace?.write({ type: "run_start", runId: run.id, kind: "plan" });

      const activePlanner = planner ?? this.deps.planner;

      const draft = await this.deps.planService.createDraftFromPlanner({
        goal,
        context: payload.context,
        sessionId: (payload as { sessionId?: string }).sessionId,
        requestId: run.id,
        planner: activePlanner,
      });

      this.deps.runs.update(run.id, {

        status: "completed",

        resultJson: JSON.stringify({ planId: draft.planId, version: draft.version }),

      });

      this.deps.trace?.write({ type: "run_end", runId: run.id, kind: "plan", status: "completed" });

      return {
        status: 200,
        body: {
          runId: run.id,
          planId: draft.planId,
          version: draft.version,
          status: draft.status,
          planHash: draft.planHash,
          previewMarkdown: draft.previewMarkdown,
          publicPlanJson: draft.publicPlanJson,
          warning: "publicPlanJson.executable 恒为 false，不可作为执行体提交",
        },
      };

    } catch (error) {

      this.deps.runs.update(run.id, { status: "failed", error: String(error) });

      this.deps.trace?.write({ type: "run_end", runId: run.id, kind: "plan", status: "failed" });

      if (error instanceof PlanValidationError) {
        return { status: 400, body: { error: error.message, code: error.code, runId: run.id } };
      }

      return { status: 502, body: { error: `生成计划失败：${String(error)}`, runId: run.id } };

    }

  }



  async runTask(body: unknown, dryRun: boolean, planner?: Planner): Promise<ApiResult> {

    const payload = (body ?? {}) as {

      plan?: unknown;

      planId?: string;

      version?: number;

      internalPlan?: unknown;

      autoConfirm?: boolean;

      sessionId?: string;

      runId?: string;

      rollbackOnFailure?: boolean;

      fallbackToPlanOnUncertainty?: boolean;

    };

    const bodyReject = this.deps.planService.rejectExecutionBody(payload as Record<string, unknown>);
    if (bodyReject && !dryRun) {
      return { status: 400, body: bodyReject };
    }

    if (payload.internalPlan !== undefined) {
      return {
        status: 400,
        body: {
          error: "执行 API 不接受 internalPlan 字段",
          code: "INTERNAL_PLAN_BODY_REJECTED",
        },
      };
    }

    if (payload.planId && payload.version) {
      return this.executeStoredPlan(payload.planId, payload.version, payload, dryRun, planner);
    }

    if (payload.plan !== undefined) {
      if (!dryRun) {
        return {
          status: 400,
          body: {
            error: "POST /api/task/run 不再接受 plan JSON。请 POST /api/plans/draft → approve → POST /api/plans/:planId/execute",
            code: "PLAN_BODY_NOT_EXECUTABLE",
          },
        };
      }
      try {
        const ingested = this.deps.planService.ingestLegacyPlanBody(payload.plan, true);
        this.deps.planService.approve(ingested.planId, ingested.version, "system:dry-run", "legacy dry-run");
        return this.executeStoredPlan(
          ingested.planId,
          ingested.version,
          payload,
          true,
          planner,
        );
      } catch (error) {
        if (error instanceof PlanValidationError) {
          return { status: 400, body: { error: error.message, code: error.code } };
        }
        throw error;
      }
    }

    return {
      status: 400,
      body: {
        error: "缺少可执行计划：需要 planId + version，或在 dry-run 下提供 plan 对象",
        code: "MISSING_PLAN_REF",
      },
    };

  }



  async executeStoredPlan(
    planId: string,
    version: number,
    payload: {
      autoConfirm?: boolean;
      sessionId?: string;
      runId?: string;
      rollbackOnFailure?: boolean;
      fallbackToPlanOnUncertainty?: boolean;
    },
    dryRun = false,
    planner?: Planner,
  ): Promise<ApiResult> {
    let internal;
    try {
      if (dryRun) {
        if (!this.deps.planService.getRecord(planId, version)) {
          return { status: 404, body: { error: "计划不存在", code: "PLAN_NOT_FOUND" } };
        }
        this.deps.planService.ensureApprovedForDryRun(planId, version);
      }
      internal = this.deps.planService.loadExecutable(planId, version);
    } catch (error) {
      if (error instanceof PlanValidationError) {
        return { status: 400, body: { error: error.message, code: error.code } };
      }
      return { status: 404, body: { error: String(error) } };
    }

    const planRun = this.deps.planService.createPlanRun(planId, version);

    this.deps.planService.markRunning(planId, version);
    const plan = legacyPlanFromInternal(internal);
    const planGoal = plan.goal ?? plan.steps[0]?.title ?? "任务";

    const sessionId = payload.sessionId

      ? this.ensureSession(payload.sessionId, planGoal)

      : undefined;

    const task = this.resolveOrCreateTask(sessionId, planGoal);
    this.persistTaskPlan(task.id, plan);



    const run = this.deps.runs.create({

      kind: dryRun ? "task_dry_run" : "task",

      status: "running",

      sessionId,

      taskId: task.id,

      goal: planGoal,

      parentRunId: payload.runId,

      correlation: this.correlationFor("", { sessionId, taskId: task.id }),

    });

    this.deps.runs.update(run.id, {

      correlationJson: JSON.stringify(this.correlationFor(run.id, { sessionId, taskId: task.id })),

    });



    try {

      this.deps.trace?.write({

        type: "run_start",

        runId: run.id,

        kind: dryRun ? "task_dry_run" : "task",

        sessionId,

        taskId: task.id,

      });

      const executedPlan = await new TaskExecutionWorkflow({
        registry: this.deps.registry,
        workspaceRoot: this.deps.workspaceRoot,
        projectAllowedPermissions: this.deps.projectAllowedPermissions,
        trace: this.deps.trace,
      }).run({
        plan,
        dryRun,
        autoConfirm: payload.autoConfirm ?? false,
        taskId: task.id,
        sessionId,
        runId: run.id,
        onUpdate: (updated) => this.persistTaskPlan(task.id, updated),
      });

      this.persistTaskPlan(task.id, executedPlan);

      const blocked = executedPlan.steps.some((s) => s.status === "blocked");
      const failed = executedPlan.steps.some((s) => s.status === "failed");
      const taskStatus = aggregateTaskStatus(executedPlan.steps);
      const runStatus =
        taskStatus === "blocked"
          ? "blocked"
          : taskStatus === "failed"
            ? "failed"
            : taskStatus === "completed"
              ? "completed"
              : "running";

      this.deps.planService.markCompleted(planId, version, taskStatus === "completed");

      this.deps.tasks.update(task.id, {
        status: taskStatus,
        summary:
          taskStatus === "completed"
            ? "全部步骤完成"
            : taskStatus === "blocked"
              ? "存在阻塞步骤，可 resume"
              : "部分步骤未完成",
      });

      if (taskStatus === "completed") this.releaseTaskFromSession(sessionId, task.id);

      let rollback: TaskRollbackResult | undefined;
      if (taskStatus === "failed" && !dryRun && payload.rollbackOnFailure) {
        rollback = await this.tryRollbackTaskFiles(run.id, sessionId, task.id);
      }

      const modeFallback = await this.tryFallbackToPlan({
        enabled: payload.fallbackToPlanOnUncertainty ?? false,
        planner,
        planGoal,
        executedPlan,
        taskRunId: run.id,
        sessionId,
        taskId: task.id,
      });

      const resultPayload = {
        planId,
        version,
        planRunId: planRun.id,
        plan: executedPlan,
        ...(rollback ? { rollback } : {}),
        ...(modeFallback ? { modeFallback } : {}),
      };

      this.deps.runs.update(run.id, {

        status: runStatus,

        resultJson: JSON.stringify(resultPayload),

      });
      this.deps.tasks.recordAttempt({
        taskId: task.id,
        runId: run.id,
        status: runStatus,
        result: JSON.stringify({ stepCount: executedPlan.steps.length, rollback, modeFallback, planId, version }),
        endedAt: new Date().toISOString(),
      });

      this.deps.trace?.write({

        type: "run_end",

        runId: run.id,

        kind: dryRun ? "task_dry_run" : "task",

        status: runStatus,

      });

      return { status: 200, body: { runId: run.id, taskId: task.id, ...resultPayload } };

    } catch (error) {

      let rollback: TaskRollbackResult | undefined;
      if (!dryRun && payload.rollbackOnFailure) {
        rollback = await this.tryRollbackTaskFiles(run.id, sessionId, task.id);
      }

      this.deps.tasks.update(task.id, { status: "failed", summary: String(error) });
      this.deps.tasks.recordAttempt({
        taskId: task.id,
        runId: run.id,
        status: "failed",
        error: String(error),
        endedAt: new Date().toISOString(),
      });

      this.releaseTaskFromSession(sessionId, task.id);

      this.deps.runs.update(run.id, {
        status: "failed",
        error: String(error),
        resultJson: rollback ? JSON.stringify({ rollback }) : undefined,
      });

      this.deps.trace?.write({ type: "run_end", runId: run.id, status: "failed" });

      return {
        status: 500,
        body: { error: String(error), runId: run.id, taskId: task.id, ...(rollback ? { rollback } : {}) },
      };

    }

  }



  async runAgent(body: unknown, makeChat?: LoopChatFn): Promise<ApiResult> {
    const prepared = this.prepareAgentRun(body, makeChat, {
      registerForCancel: true,
      enableTimeline: true,
    });
    if ("error" in prepared) return prepared.error;
    const { ctx } = prepared;

    try {
      this.traceAgentRunStart(ctx);
      const result = await ctx.loop.run(ctx.message, ctx.system);
      return { status: 200, body: this.finalizeAgentRunSuccess(ctx, result) };
    } catch (error) {
      return { status: 502, body: this.finalizeAgentRunFailure(ctx, error) };
    } finally {
      this.deps.agentRunRegistry.unregister(ctx.run.id);
    }
  }

  /** 从 RunStateStore 恢复预算耗尽的可续跑 Agent Run（PlanWorkflow pendingSteps）。 */
  async resumeAgent(body: unknown, makeChat?: LoopChatFn): Promise<ApiResult> {
    const payload = (body ?? {}) as {
      runId?: string;
      budget?: Partial<RunBudget>;
      message?: string;
      autoConfirm?: boolean;
      sensitive?: boolean;
      taskType?: string;
      permissionPolicy?: string;
      clientName?: string;
    };
    const runId = (payload.runId ?? "").trim();
    if (!runId) return { status: 400, body: { error: "runId 不能为空" } };

    const run = this.deps.runs.get(runId);
    if (!run) return { status: 404, body: { error: "运行记录不存在", runId } };
    if (run.kind !== "agent") {
      return { status: 400, body: { error: "仅 agent 类型 Run 支持续跑", runId, kind: run.kind } };
    }

    const state = this.deps.runStateStore.get(runId);
    if (!state || state.status !== "resumable") {
      return {
        status: 400,
        body: {
          error: "该 Run 不可续跑（无 resumable 状态或已完成）",
          runId,
          pendingSteps: state?.pendingSteps,
        },
      };
    }

    const taskTypeParsed = parseModelTaskTypeOrError(payload.taskType);
    if (!taskTypeParsed.ok) {
      return { status: 400, body: { error: taskTypeParsed.error } };
    }
    if (payload.permissionPolicy && !defaultRunPolicyManager.parsePermissionPolicy(payload.permissionPolicy)) {
      return {
        status: 400,
        body: {
          error: "permissionPolicy 必须是 readOnly/confirmBeforeEdit/autoEdit/confirmBeforeRun/autoRun",
        },
      };
    }

    const policy = defaultRunPolicyManager.resolve({
      requestedMode: state.mode,
      requestedPermissionPolicy: payload.permissionPolicy,
      autoConfirm: payload.autoConfirm,
      budget: payload.budget,
      taskType: taskTypeParsed.taskType,
      message: state.goal,
    });

    const message = (payload.message ?? "").trim() || state.goal;
    const sessionId = state.sessionId;
    const task = state.taskId
      ? this.deps.tasks.get(state.taskId)
      : this.resolveOrCreateTask(sessionId, state.goal.slice(0, 500));
    if (!task) {
      return { status: 404, body: { error: "关联 task 不存在", taskId: state.taskId } };
    }

    this.deps.runs.update(runId, { status: "running", error: undefined });
    this.deps.tasks.update(task.id, { status: "running" });

    const loop = new AgentLoop({
      chat: makeChat ?? this.deps.makeChatFn(),
      registry: this.deps.registry,
      workspaceRoot: this.deps.workspaceRoot,
      autoConfirm: payload.autoConfirm ?? false,
      sensitive: payload.sensitive,
      taskType: taskTypeParsed.taskType,
      policy,
      projectAllowedPermissions: this.deps.projectAllowedPermissions,
      trace: this.deps.trace,
      notificationQueue: this.deps.notificationQueue,
      contextManager: sessionId ? this.deps.contextManager : undefined,
      sessionId,
      runId,
      taskId: task.id,
      requestId: runId,
      runStateStore: this.deps.runStateStore,
      projectIndex: this.deps.projectIndex,
      resumeState: state,
      maxCostUsdPerRun: this.deps.maxCostUsdPerRun,
      subAgentDispatchDepth: 0,
      maxSubAgentDispatchDepth: this.deps.maxSubAgentDispatchDepth ?? 1,
    });

    const ctx = { message, sessionId, task, run: { id: runId }, loop };

    try {
      this.deps.trace?.write({
        type: "run_resume",
        runId,
        kind: "agent",
        sessionId,
        taskId: task.id,
        pendingSteps: state.pendingSteps,
        completedSteps: state.completedSteps,
      });
      const result = await loop.run(message);
      return { status: 200, body: this.finalizeAgentRunSuccess(ctx, result, { resumed: true }) };
    } catch (error) {
      return { status: 502, body: this.finalizeAgentRunFailure(ctx, error) };
    }
  }

  getRunState(runId: string): RunState | null {
    return this.deps.runStateStore.get(runId);
  }

  listRunningAgentRuns() {
    return this.deps.agentRunRegistry.listRunning();
  }

  cancelRun(runId: string): ApiResult {
    const id = runId.trim();
    if (!id) return { status: 400, body: { error: "runId 不能为空" } };
    const result = this.deps.agentRunRegistry.cancel(id);
    if (!result) return { status: 404, body: { error: "运行不存在或已结束", runId: id } };
    return { status: 200, body: result };
  }

  getActivityRun(runId: string): ApiResult {
    const store = new ActivityRunStore(this.deps.workspaceRoot);
    const run = store.loadRun(runId);
    if (!run) return { status: 404, body: { error: "Activity Run 不存在", runId } };
    return { status: 200, body: { run } };
  }

  subscribeActivityEvents(
    runId: string,
    emit: (event: AgentActivityEvent) => void,
    opts?: { replay?: boolean },
  ): () => void {
    const store = new ActivityRunStore(this.deps.workspaceRoot);
    if (opts?.replay !== false) {
      for (const event of store.listEvents(runId)) {
        emit(event);
      }
    }
    return defaultActivityEventBus.subscribe(runId, emit);
  }

  /** SSE：推送 run_start / model_turn / step / token / done | error。 */
  async runAgentStream(
    body: unknown,
    emit: (event: AgentStreamEvent) => void,
    makeChat?: LoopChatFn,
  ): Promise<void> {
    const payload = (body ?? {}) as { streamTokens?: boolean };
    let activeIteration = 0;
    // run_start 必须是流的首帧；prepareAgentRun 会在准备阶段就启动 timeline 并产生
    // activity_event，因此先缓冲这些事件，待 run_start 发出后再按序补发，避免乱序。
    let runStarted = false;
    const activityBuffer: AgentActivityEvent[] = [];
    const prepared = this.prepareAgentRun(body, makeChat, {
      onStep: (step) => emit({ type: "step", step }),
      onModelTurn: (turn) => {
        activeIteration = turn.iteration;
        emit({ type: "model_turn", turn });
      },
      onToken: payload.streamTokens
        ? (delta) => emit({ type: "token", delta, iteration: activeIteration || undefined })
        : undefined,
      registerForCancel: true,
      enableTimeline: true,
      onActivityEvent: (event) => {
        if (!runStarted) {
          activityBuffer.push(event);
          return;
        }
        emit({ type: "activity_event", event });
      },
    });
    if ("error" in prepared) throw new Error(String((prepared.error.body as { error?: string }).error));
    const { ctx } = prepared;

    emit({ type: "run_start", runId: ctx.run.id, taskId: ctx.task.id, sessionId: ctx.sessionId });
    runStarted = true;
    for (const event of activityBuffer) emit({ type: "activity_event", event });
    activityBuffer.length = 0;

    try {
      this.traceAgentRunStart(ctx);
      const result = await ctx.loop.run(ctx.message, ctx.system);
      emit({ type: "done", ...this.finalizeAgentRunSuccess(ctx, result) });
    } catch (error) {
      const body = this.finalizeAgentRunFailure(ctx, error);
      emit({
        type: "error",
        error: String((body as { error?: string }).error),
        runId: ctx.run.id,
        taskId: ctx.task.id,
      });
    } finally {
      this.deps.agentRunRegistry.unregister(ctx.run.id);
    }
  }



  /** 调度器无人值守触发：创建 scheduled Run 并执行 Agent 循环（不持久化会话）。 */

  async executeUnattendedTrigger(input: {

    triggerId: string;

    goal: string;

    sessionId?: string;

  }): Promise<{ runId: string }> {

    const run = this.deps.runs.create({

      kind: "scheduled",

      status: "running",

      goal: input.goal,

      triggerId: input.triggerId,

      sessionId: input.sessionId,

      correlation: this.correlationFor("", { triggerId: input.triggerId, sessionId: input.sessionId }),

    });

    this.deps.runs.update(run.id, {

      correlationJson: JSON.stringify(

        this.correlationFor(run.id, { triggerId: input.triggerId, sessionId: input.sessionId }),

      ),

    });



    const loop = new AgentLoop({

      chat: this.deps.makeChatFn(),

      registry: this.deps.registry,

      workspaceRoot: this.deps.workspaceRoot,

      autoConfirm: false,

      notificationQueue: this.deps.notificationQueue,

      trace: this.deps.trace,

      runId: run.id,

      requestId: run.id,

      subAgentDispatchDepth: 0,

      maxSubAgentDispatchDepth: this.deps.maxSubAgentDispatchDepth ?? 1,

    });



    try {

      this.deps.trace?.write({

        type: "run_start",

        runId: run.id,

        kind: "scheduled",

        triggerId: input.triggerId,

      });

      const result = await loop.run(input.goal);

      this.deps.runs.update(run.id, {

        status: result.reachedLimit ? "failed" : "completed",

        resultJson: JSON.stringify({
          answer: result.answer,
          iterations: result.iterations,
          executionMeta: result.executionMeta,
        }),

      });

      this.deps.trace?.write({

        type: "run_end",

        runId: run.id,

        kind: "scheduled",

        status: result.reachedLimit ? "failed" : "completed",

      });

    } catch (error) {

      this.deps.runs.update(run.id, { status: "failed", error: String(error) });

      this.deps.trace?.write({ type: "run_end", runId: run.id, kind: "scheduled", status: "failed" });

    }

    return { runId: run.id };

  }



  createScheduledRun(input: {

    goal: string;

    triggerId: string;

    sessionId?: string;

  }): { runId: string } {

    const run = this.deps.runs.create({

      kind: "scheduled",

      status: "pending",

      goal: input.goal,

      triggerId: input.triggerId,

      sessionId: input.sessionId,

      correlation: this.correlationFor("", {

        triggerId: input.triggerId,

        sessionId: input.sessionId,

      }),

    });

    this.deps.runs.update(run.id, {

      correlationJson: JSON.stringify(

        this.correlationFor(run.id, { triggerId: input.triggerId, sessionId: input.sessionId }),

      ),

    });

    return { runId: run.id };

  }



  async runSubAgent(body: unknown, forceClient?: string): Promise<ApiResult> {
    const payload = (body ?? {}) as {
      task?: import("../subagent/delegatedTask.js").DelegatedTask;
      parentTaskId?: string;
      grantedPermissions?: string[];
      timeoutMs?: number;
      sensitive?: boolean;
    };

    if (!payload.task?.goal?.trim()) {
      return { status: 400, body: { error: "task 须为含 goal 的 DelegatedTask 对象" } };
    }

    const coord = this.deps.subAgentCoordinatorFor?.(forceClient) ?? this.deps.subAgentCoordinator;
    if (!coord) return { status: 503, body: { error: "子 Agent 未启用" } };

    const goalLabel = payload.task.goal.slice(0, 200);
    const run = this.deps.runs.create({
      kind: "agent",
      status: "running",
      goal: goalLabel,
      taskId: payload.parentTaskId,
      correlation: this.correlationFor("", { taskId: payload.parentTaskId }),
    });
    this.deps.runs.update(run.id, {
      correlationJson: JSON.stringify(this.correlationFor(run.id, { taskId: payload.parentTaskId })),
    });

    try {
      this.deps.trace?.write({ type: "run_start", runId: run.id, kind: "subagent", goal: goalLabel });

      const result = await coord.runDelegated(payload.task, {
        parentTaskId: payload.parentTaskId,
        grantedPermissions: payload.grantedPermissions as ToolPermission[] | undefined,
        timeoutMs: payload.timeoutMs,
        sensitive: payload.sensitive,
      });

      this.deps.runs.update(run.id, {
        status: result.status === "cancelled" ? "cancelled" : "completed",
        resultJson: JSON.stringify({
          goal: result.goal,
          summary: result.structured?.summary ?? result.answer?.slice(0, 500),
          subAgentId: result.id,
        }),
      });

      this.deps.trace?.write({
        type: "run_end",
        runId: run.id,
        kind: "subagent",
        status: result.status === "cancelled" ? "cancelled" : "completed",
      });

      return { status: 200, body: { runId: run.id, result } };
    } catch (error) {
      this.deps.runs.update(run.id, { status: "failed", error: String(error) });
      this.deps.trace?.write({ type: "run_end", runId: run.id, kind: "subagent", status: "failed" });
      return { status: 400, body: { error: String(error), runId: run.id } };
    }
  }



  async runSubAgentBatch(body: unknown, forceClient?: string): Promise<ApiResult> {
    const payload = (body ?? {}) as {
      tasks?: import("../subagent/delegatedTask.js").DelegatedTask[];
      parentTaskId?: string;
      grantedPermissions?: string[];
      timeoutMs?: number;
      sensitive?: boolean;
      arbitrateConflicts?: boolean;
      autoMergeWrites?: boolean;
      writeFilePickStrategy?: "latest" | "earliest" | "arbitration";
    };

    if (!payload.tasks?.length) {
      return { status: 400, body: { error: "tasks 不能为空" } };
    }

    const coord = this.deps.subAgentCoordinatorFor?.(forceClient) ?? this.deps.subAgentCoordinator;
    if (!coord) return { status: 503, body: { error: "子 Agent 未启用" } };

    const run = this.deps.runs.create({
      kind: "agent",
      status: "running",
      goal: payload.tasks[0]!.goal.slice(0, 200),
      taskId: payload.parentTaskId,
      correlation: this.correlationFor("", { taskId: payload.parentTaskId }),
    });
    this.deps.runs.update(run.id, {
      correlationJson: JSON.stringify(this.correlationFor(run.id, { taskId: payload.parentTaskId })),
    });

    try {
      this.deps.trace?.write({
        type: "run_start",
        runId: run.id,
        kind: "subagent_batch",
        taskCount: payload.tasks.length,
      });
      const batch = await coord.runBatch({
        tasks: payload.tasks,
        parentTaskId: payload.parentTaskId,
        grantedPermissions: payload.grantedPermissions as ToolPermission[] | undefined,
        timeoutMs: payload.timeoutMs ?? 180_000,
        sensitive: payload.sensitive,
        arbitrateConflicts: payload.arbitrateConflicts,
        autoMergeWrites: payload.autoMergeWrites,
        writeFilePickStrategy: payload.writeFilePickStrategy,
      });
      this.deps.runs.update(run.id, {
        status: "completed",
        resultJson: JSON.stringify({ taskCount: payload.tasks.length }),
      });
      this.deps.trace?.write({ type: "run_end", runId: run.id, kind: "subagent_batch", status: "completed" });
      return { status: 200, body: { runId: run.id, ...batch } };
    } catch (error) {
      this.deps.runs.update(run.id, { status: "failed", error: String(error) });
      this.deps.trace?.write({ type: "run_end", runId: run.id, kind: "subagent_batch", status: "failed" });
      return { status: 400, body: { error: String(error), runId: run.id } };
    }
  }



  cancelSubAgent(subAgentId: string): ApiResult {

    const coord = this.deps.subAgentCoordinator;

    if (!coord) return { status: 503, body: { error: "子 Agent 未启用" } };

    const result = coord.cancel(subAgentId);

    if (!result) {
      return { status: 404, body: { error: `子 Agent 不在运行中：${subAgentId}` } };
    }

    this.deps.trace?.write({
      type: "subagent_cancel",
      subAgentId,
      goal: result.goal,
      parentTaskId: result.parentTaskId,
    });

    return { status: 200, body: result };

  }



  private correlationFor(runId: string, extra: Omit<CorrelationContext, "runId">): CorrelationContext {

    return { runId, ...extra };

  }

  private prepareAgentRun(
    body: unknown,
    makeChat?: LoopChatFn,
    callbacks?: {
      onStep?: (step: AgentToolStep) => void;
      onModelTurn?: (turn: import("../agent/AgentModelTurn.js").AgentModelTurnEvent) => void;
      onToken?: (delta: string) => void;
      registerForCancel?: boolean;
      enableTimeline?: boolean;
      onActivityEvent?: (event: AgentActivityEvent) => void;
    },
  ):
    | { error: ApiResult }
    | {
        ctx: {
          message: string;
          system?: string;
          sessionId?: string;
          task: TaskRecord;
          run: { id: string };
          loop: AgentLoop;
        };
      } {
    const payload = (body ?? {}) as {
      message?: string;
      system?: string;
      autoConfirm?: boolean;
      sensitive?: boolean;
      taskType?: string;
      mode?: string;
      permissionPolicy?: string;
      budget?: Partial<RunBudget>;
      sessionId?: string;
      persist?: boolean;
    };
    const message = (payload.message ?? "").trim();
    if (!message) return { error: { status: 400, body: { error: "message 不能为空" } } };

    const taskTypeParsed = parseModelTaskTypeOrError(payload.taskType);
    if (!taskTypeParsed.ok) {
      return { error: { status: 400, body: { error: taskTypeParsed.error } } };
    }
    if (payload.mode && !defaultRunPolicyManager.parseMode(payload.mode)) {
      return { error: { status: 400, body: { error: "mode 必须是 chat/plan/implement/debug/review" } } };
    }
    if (payload.permissionPolicy && !defaultRunPolicyManager.parsePermissionPolicy(payload.permissionPolicy)) {
      return {
        error: {
          status: 400,
          body: {
            error:
              "permissionPolicy 必须是 readOnly/confirmBeforeEdit/autoEdit/confirmBeforeRun/autoRun",
          },
        },
      };
    }
    const policy = defaultRunPolicyManager.resolve({
      requestedMode: payload.mode,
      requestedPermissionPolicy: payload.permissionPolicy,
      autoConfirm: payload.autoConfirm,
      budget: payload.budget,
      taskType: taskTypeParsed.taskType,
      message,
    });

    const persist = payload.persist !== false;
    const sessionId = persist ? this.ensureSession(payload.sessionId, "智能体会话") : undefined;
    const task = this.resolveOrCreateTask(sessionId, message.slice(0, 500));
    const run = this.deps.runs.create({
      kind: "agent",
      status: "running",
      sessionId,
      taskId: task.id,
      goal: message.slice(0, 200),
      correlation: this.correlationFor("", { sessionId, taskId: task.id }),
    });
    this.deps.runs.update(run.id, {
      correlationJson: JSON.stringify(this.correlationFor(run.id, { sessionId, taskId: task.id })),
    });

    const cancelSignal = callbacks?.registerForCancel
      ? this.deps.agentRunRegistry.register(run.id, "agent").signal
      : undefined;

    const timeline = callbacks?.enableTimeline
      ? new AgentTimelineService({
          workspaceRoot: this.deps.workspaceRoot,
          onEvent: callbacks.onActivityEvent,
        })
      : undefined;
    if (timeline) {
      timeline.createRun({
        id: run.id,
        goal: message,
        sessionId,
        metadata: {
          userInput: message,
          mode: policy.mode,
          projectRoot: this.deps.workspaceRoot,
        },
      });
    }

    const loop = new AgentLoop({
      chat: makeChat ?? this.deps.makeChatFn(),
      registry: this.deps.registry,
      workspaceRoot: this.deps.workspaceRoot,
      autoConfirm: payload.autoConfirm ?? false,
      sensitive: payload.sensitive,
      taskType: taskTypeParsed.taskType,
      policy,
      projectAllowedPermissions: this.deps.projectAllowedPermissions,
      trace: this.deps.trace,
      notificationQueue: this.deps.notificationQueue,
      contextManager: persist ? this.deps.contextManager : undefined,
      sessionId,
      runId: run.id,
      taskId: task.id,
      requestId: run.id,
      runStateStore: this.deps.runStateStore,
      projectIndex: this.deps.projectIndex,
      onStep: callbacks?.onStep,
      onModelTurn: callbacks?.onModelTurn,
      onToken: callbacks?.onToken,
      maxCostUsdPerRun: this.deps.maxCostUsdPerRun,
      subAgentDispatchDepth: 0,
      maxSubAgentDispatchDepth: this.deps.maxSubAgentDispatchDepth ?? 1,
      signal: cancelSignal,
      timeline,
    });

    return {
      ctx: {
        message,
        system: payload.system,
        sessionId,
        task,
        run,
        loop,
      },
    };
  }

  private traceAgentRunStart(ctx: {
    run: { id: string };
    sessionId?: string;
    task: TaskRecord;
  }): void {
    this.deps.trace?.write({
      type: "run_start",
      runId: ctx.run.id,
      kind: "agent",
      sessionId: ctx.sessionId,
      taskId: ctx.task.id,
    });
  }

  private finalizeAgentRunSuccess(
    ctx: { sessionId?: string; task: TaskRecord; run: { id: string } },
    result: AgentRunResult,
    extra?: { resumed?: boolean },
  ): AgentRunResult & { runId: string; taskId: string; runState?: RunState | null; resumed?: boolean } {
    const cancelled = result.executionMeta.stopReason === "user_cancelled";
    this.deps.tasks.update(ctx.task.id, {
      status: cancelled ? "cancelled" : result.reachedLimit ? "failed" : "done",
      summary: result.answer.slice(0, 500),
    });
    if (!result.reachedLimit && !cancelled) this.releaseTaskFromSession(ctx.sessionId, ctx.task.id);
    const runState = result.reachedLimit
      ? this.deps.runStateStore.get(ctx.run.id)
      : null;
    this.deps.runs.update(ctx.run.id, {
      status: cancelled ? "cancelled" : result.reachedLimit ? "failed" : "completed",
      resultJson: JSON.stringify({
        answer: result.answer,
        iterations: result.iterations,
        executionMeta: result.executionMeta,
        routerDecision: result.routerDecision,
        promptStrategy: result.promptStrategy,
        runState: runState
          ? { status: runState.status, pendingSteps: runState.pendingSteps, completedSteps: runState.completedSteps }
          : undefined,
        resumed: extra?.resumed,
      }),
    });
    this.deps.trace?.write({
      type: "run_end",
      runId: ctx.run.id,
      kind: "agent",
      status: cancelled ? "cancelled" : result.reachedLimit ? "failed" : "completed",
      resumed: extra?.resumed,
      resumable: runState?.status === "resumable",
    });
    return {
      ...result,
      runId: ctx.run.id,
      taskId: ctx.task.id,
      runState: runState ?? undefined,
      resumed: extra?.resumed,
    };
  }

  private finalizeAgentRunFailure(
    ctx: { sessionId?: string; task: TaskRecord; run: { id: string } },
    error: unknown,
  ): { error: string; runId: string; taskId: string } {
    this.deps.tasks.update(ctx.task.id, { status: "failed", summary: String(error) });
    this.releaseTaskFromSession(ctx.sessionId, ctx.task.id);
    this.deps.runs.update(ctx.run.id, { status: "failed", error: String(error) });
    this.deps.trace?.write({ type: "run_end", runId: ctx.run.id, kind: "agent", status: "failed" });
    return { error: String(error), runId: ctx.run.id, taskId: ctx.task.id };
  }

  private async tryFallbackToPlan(input: {
    enabled: boolean;
    planner?: Planner;
    planGoal: string;
    executedPlan: Plan;
    taskRunId: string;
    sessionId?: string;
    taskId: string;
  }): Promise<ModeFallbackResult | undefined> {
    if (!input.enabled) return undefined;
    const uncertainty = detectTaskUncertainty(input.executedPlan);
    if (!uncertainty.uncertain) return undefined;

    const activePlanner = input.planner ?? this.deps.planner;
    const planRun = this.deps.runs.create({
      kind: "plan",
      status: "running",
      goal: input.planGoal,
      parentRunId: input.taskRunId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      correlation: this.correlationFor("", {
        sessionId: input.sessionId,
        taskId: input.taskId,
      }),
    });
    this.deps.runs.update(planRun.id, {
      correlationJson: JSON.stringify(
        this.correlationFor(planRun.id, { sessionId: input.sessionId, taskId: input.taskId }),
      ),
    });

    this.deps.trace?.write({
      type: "task_fallback_plan_start",
      runId: input.taskRunId,
      planRunId: planRun.id,
      taskId: input.taskId,
      reasonCount: uncertainty.reasons.length,
    });

    try {
      const context = buildPlanFallbackContext(input.executedPlan, uncertainty.reasons);
      const revisedPlan = await activePlanner.generatePlan(input.planGoal, context);
      this.deps.runs.update(planRun.id, {
        status: "completed",
        resultJson: JSON.stringify({ goal: revisedPlan.goal, stepCount: revisedPlan.steps.length }),
      });
      this.deps.trace?.write({
        type: "task_fallback_plan_end",
        runId: input.taskRunId,
        planRunId: planRun.id,
        status: "completed",
      });
      return {
        triggered: true,
        reasons: uncertainty.reasons,
        revisedPlan,
        planRunId: planRun.id,
      };
    } catch (error) {
      this.deps.runs.update(planRun.id, { status: "failed", error: String(error) });
      this.deps.trace?.write({
        type: "task_fallback_plan_end",
        runId: input.taskRunId,
        planRunId: planRun.id,
        status: "failed",
        error: String(error),
      });
      return {
        triggered: true,
        reasons: uncertainty.reasons,
        planRunId: planRun.id,
        error: String(error),
      };
    }
  }

  private async tryRollbackTaskFiles(
    runId: string,
    sessionId: string | undefined,
    taskId: string,
  ): Promise<TaskRollbackResult | undefined> {
    const storage = this.deps.registry.getStorage();
    if (!storage) return undefined;
    return rollbackFileChangesForRun({
      registry: this.deps.registry,
      storage,
      workspaceRoot: this.deps.workspaceRoot,
      runId,
      sessionId,
      taskId,
      trace: this.deps.trace,
    });
  }

  getTask(taskId: string): ApiResult {
    const task = this.deps.tasks.get(taskId);
    if (!task) return { status: 404, body: { error: "任务不存在" } };
    const steps = this.deps.tasks.listSteps(taskId);
    const plan = planFromTask(task, steps);
    return {
      status: 200,
      body: {
        task: { ...task, status: aggregateTaskStatus(plan.steps) },
        steps,
        plan,
      },
    };
  }

  async resumeTask(taskId: string, body: unknown): Promise<ApiResult> {
    const payload = (body ?? {}) as {
      action?: string;
      stepId?: string;
      autoConfirm?: boolean;
      dryRun?: boolean;
    };
    if (!payload.action || !payload.stepId) {
      return { status: 400, body: { error: "需要 action 与 stepId" } };
    }
    if (payload.action !== "retry" && payload.action !== "skip" && payload.action !== "confirm") {
      return { status: 400, body: { error: "action 须为 retry | skip | confirm" } };
    }

    const task = this.deps.tasks.get(taskId);
    if (!task) return { status: 404, body: { error: "任务不存在" } };
    const steps = this.deps.tasks.listSteps(taskId);
    const plan = planFromTask(task, steps);

    const sessionId = task.sessionId;
    const dryRun = payload.dryRun ?? false;
    const run = this.deps.runs.create({
      kind: dryRun ? "task_dry_run" : "task",
      status: "running",
      sessionId,
      taskId,
      goal: task.goal,
    });

    try {
      this.deps.trace?.write({
        type: "run_start",
        runId: run.id,
        kind: dryRun ? "task_dry_run" : "task",
        sessionId,
        taskId,
        resumeAction: payload.action,
        resumeStepId: payload.stepId,
      });

      const executedPlan = await new TaskExecutionWorkflow({
        registry: this.deps.registry,
        workspaceRoot: this.deps.workspaceRoot,
        projectAllowedPermissions: this.deps.projectAllowedPermissions,
        trace: this.deps.trace,
      }).resume({
        plan,
        dryRun,
        autoConfirm: payload.autoConfirm ?? false,
        taskId,
        sessionId,
        runId: run.id,
        onUpdate: (updated) => this.persistTaskPlan(taskId, updated),
        action: payload.action,
        stepId: payload.stepId,
      });
      this.persistTaskPlan(taskId, executedPlan);

      const taskStatus = aggregateTaskStatus(executedPlan.steps);
      this.deps.tasks.update(taskId, {
        status: taskStatus,
        summary:
          taskStatus === "completed"
            ? "全部步骤完成"
            : taskStatus === "blocked"
              ? "存在阻塞步骤，可 resume"
              : "部分步骤未完成",
      });
      if (taskStatus === "completed") this.releaseTaskFromSession(sessionId, taskId);

      const runStatus =
        taskStatus === "blocked"
          ? "blocked"
          : taskStatus === "failed"
            ? "failed"
            : taskStatus === "completed"
              ? "completed"
              : "running";

      this.deps.runs.update(run.id, {
        status: runStatus,
        resultJson: JSON.stringify({ plan: executedPlan, resumeAction: payload.action }),
      });
      this.deps.tasks.recordAttempt({
        taskId,
        runId: run.id,
        status: runStatus,
        result: JSON.stringify({ action: payload.action, stepId: payload.stepId }),
      });

      return {
        status: 200,
        body: {
          runId: run.id,
          taskId,
          taskStatus,
          plan: executedPlan,
          resumeAction: payload.action,
        },
      };
    } catch (error) {
      this.deps.runs.update(run.id, { status: "failed", error: String(error) });
      return { status: 400, body: { error: String(error) } };
    }
  }

  private persistTaskPlan(taskId: string, plan: Plan): void {
    this.deps.tasks.update(taskId, {
      inputs: plan.inputs,
      outputs: plan.outputs,
      acceptanceCriteria: plan.acceptanceCriteria,
    });

    this.deps.tasks.upsertSteps(
      taskId,
      plan.steps.map((step, index) => ({
        stepId: step.id,
        position: index,
        title: step.title,
        objective: step.objective,
        description: step.description,
        status: step.status,
        requiredPermissions: step.requiredPermissions,
        needsConfirmation: step.needsConfirmation,
        acceptance: step.acceptance,
        dependsOn: step.dependsOn,
        requiredContext: step.requiredContext,
        availableTools: step.availableTools,
        expectedArtifacts: step.expectedArtifacts,
        priority: step.priority,
        tool: step.tool,
        toolInput: step.toolInput,
        result: step.result,
        error: step.error,
      })),
    );
  }



  private resolveOrCreateTask(sessionId: string | undefined, goal: string): TaskRecord {

    if (sessionId) {

      const active = this.deps.tasks.getActiveForSession(sessionId);

      if (active) return active;

    }

    const task = this.deps.tasks.create({

      goal,

      sessionId,

      status: "in_progress",

    });

    if (sessionId) this.bindTaskToSession(sessionId, task.id);

    return task;

  }



  private bindTaskToSession(sessionId: string, taskId: string): void {

    this.deps.contextManager.setActiveTask(sessionId, taskId);

  }



  private releaseTaskFromSession(sessionId: string | undefined, taskId: string): void {

    if (!sessionId) return;

    const session = this.deps.contextManager.getSession(sessionId);

    if (session?.activeTaskId === taskId) {

      this.deps.contextManager.setActiveTask(sessionId, null);

    }

  }

}
