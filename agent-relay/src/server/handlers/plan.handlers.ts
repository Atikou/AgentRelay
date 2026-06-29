import type { AppContext } from "../../app/createAppContext.js";
import type { ApiResult } from "../../orchestrator/Orchestrator.js";
import { Planner } from "../../agent/Planner.js";
import { PlanCompileWorkflow } from "../../agent/PlanCompileWorkflow.js";
import { PlanReportWorkflow } from "../../agent/PlanReportWorkflow.js";
import { PlanActivationWorkflow } from "../../plan/PlanActivationWorkflow.js";
import type { PlanExecutionMode } from "../../plan/PlanActivationWorkflow.js";
import { PlanRuntime } from "../../plan/PlanRuntime.js";
import { PlanValidationError } from "../../plan/index.js";
import { detectPlanReportRequest } from "../../plan/planIntent.js";
import type { PlanMode } from "../../plan/types.js";
import { parseUserPermissionPolicyValue, type RunBudget } from "../../agent/RunPolicyTypes.js";

export async function handlePlanGet(app: AppContext, planId: string): Promise<ApiResult> {
  const summary = app.planService.getPlanSummary(planId);
  if (!summary) return { status: 404, body: { error: "计划不存在" } };
  return { status: 200, body: summary };
}

export async function handlePlanRevise(app: AppContext, planId: string, body: unknown): Promise<ApiResult> {
  const payload = (body ?? {}) as {
    baseVersion?: number;
    revisionRequest?: string;
    sessionId?: string;
    clientName?: string;
  };
  const revisionRequest = (payload.revisionRequest ?? "").trim();
  if (!revisionRequest) {
    return { status: 400, body: { error: "revisionRequest 不能为空" } };
  }
  const { forceClient, error } = app.resolveForceClient(payload.clientName);
  if (error) return { status: 404, body: { error } };
  const planner = forceClient ? new Planner(app.makeChatFn(forceClient)) : app.planner;
  try {
    const draft = await app.planService.revisePlan({
      planId,
      baseVersion: payload.baseVersion,
      revisionRequest,
      sessionId: payload.sessionId,
      planner,
    });
    return {
      status: 200,
      body: {
        ...draft,
        warning: "修订版为 awaiting_approval 草案，需重新审批后才能执行",
      },
    };
  } catch (err) {
    if (err instanceof PlanValidationError) {
      const status = err.message.includes("不存在") ? 404 : 400;
      return { status, body: { error: err.message, code: err.code } };
    }
    return { status: 502, body: { error: `修订计划失败：${String(err)}` } };
  }
}

export async function handlePlanDraft(app: AppContext, body: unknown): Promise<ApiResult> {
  const payload = (body ?? {}) as {
    goal?: string;
    context?: string;
    sessionId?: string;
    mode?: PlanMode;
    clientName?: string;
    autoActivate?: boolean;
    dryRun?: boolean;
    autoApprove?: boolean;
    autoConfirm?: boolean;
    executionMode?: PlanExecutionMode;
  };
  const goal = (payload.goal ?? "").trim();
  if (!goal) return { status: 400, body: { error: "goal 不能为空" } };
  const reportRequest = detectPlanReportRequest(goal);
  if (reportRequest) return { status: 400, body: reportRequest };

  const { forceClient, error } = app.resolveForceClient(payload.clientName);
  if (error) return { status: 404, body: { error } };
  const planner = forceClient ? new Planner(app.makeChatFn(forceClient)) : app.planner;

  const runtime = new PlanRuntime({
    planService: app.planService,
    executeStoredPlan: (planId, version, execPayload, dryRun) =>
      app.orchestrator.executeStoredPlan(planId, version, execPayload, dryRun),
    planner,
  });

  if (payload.autoActivate) {
    return runtime.activateFromDraft({
      goal,
      context: payload.context,
      sessionId: payload.sessionId,
      dryRun: payload.dryRun,
      autoApprove: payload.autoApprove,
      autoConfirm: payload.autoConfirm,
      executionMode: payload.executionMode,
      planner,
    });
  }

  try {
    const draft = await app.planService.createDraftFromPlanner({
      goal,
      context: payload.context,
      sessionId: payload.sessionId,
      mode: payload.mode,
      planner,
    });
    return {
      status: 200,
      body: {
        ...draft,
        warning: "previewMarkdown / publicPlanJson 仅供展示，不可直接执行",
        nextAction: {
          activate: "POST /api/plans/draft with autoActivate:true",
          approve: `POST /api/plans/${draft.planId}/approve`,
          execute: `POST /api/plans/${draft.planId}/execute`,
        },
      },
    };
  } catch (err) {
    if (err instanceof PlanValidationError) {
      return { status: 400, body: { error: err.message, code: err.code } };
    }
    return { status: 502, body: { error: `生成计划失败：${String(err)}` } };
  }
}

export async function handlePlanAnalyze(app: AppContext, body: unknown): Promise<ApiResult> {
  const payload = (body ?? {}) as {
    goal?: string;
    context?: string;
    sessionId?: string;
    clientName?: string;
    budget?: Partial<RunBudget>;
    autoActivate?: boolean;
    dryRun?: boolean;
    autoApprove?: boolean;
    autoConfirm?: boolean;
    executionMode?: PlanExecutionMode;
    confirmedTodoIds?: string[];
  };
  const goal = (payload.goal ?? "").trim();
  if (!goal) return { status: 400, body: { error: "goal 不能为空" } };

  const { forceClient, error } = app.resolveForceClient(payload.clientName);
  if (error) return { status: 404, body: { error } };
  const makeChat = forceClient ? app.makeChatFn(forceClient) : undefined;
  const analyzeResult = await new PlanReportWorkflow({
    planService: app.planService,
    runAgent: (agentBody, agentMakeChat) => app.orchestrator.runAgent(agentBody, agentMakeChat),
  }).run({
    goal,
    context: payload.context,
    sessionId: payload.sessionId,
    clientName: payload.clientName,
    budget: payload.budget,
    makeChat,
  });

  if (analyzeResult.status !== 200) return analyzeResult;

  const body200 = analyzeResult.body as {
    userVisiblePlan?: { id: string };
    runId?: string;
    sessionId?: string;
  };
  const userVisiblePlanId = body200.userVisiblePlan?.id;
  const enriched = {
    ...(typeof analyzeResult.body === "object" && analyzeResult.body !== null
      ? (analyzeResult.body as Record<string, unknown>)
      : {}),
    nextAction: userVisiblePlanId
      ? {
          activate: `POST /api/plans/${userVisiblePlanId}/activate`,
          compile: `POST /api/plans/${userVisiblePlanId}/compile`,
        }
      : undefined,
  };

  if (!payload.autoActivate || !userVisiblePlanId) {
    return { status: 200, body: enriched };
  }

  const activation = await handlePlanActivate(app, userVisiblePlanId, {
    sessionId: body200.sessionId ?? payload.sessionId,
    dryRun: payload.dryRun,
    autoApprove: payload.autoApprove,
    autoConfirm: payload.autoConfirm,
    executionMode: payload.executionMode,
    confirmedTodoIds: payload.confirmedTodoIds,
  });
  if (activation.status !== 200) {
    return {
      status: activation.status,
      body: { analyze: enriched, activation: activation.body },
    };
  }
  return {
    status: 200,
    body: { ...enriched, activation: activation.body },
  };
}

export async function handlePlanActivate(
  app: AppContext,
  userVisiblePlanId: string,
  body: unknown,
): Promise<ApiResult> {
  const payload = (body ?? {}) as {
    confirmedTodoIds?: string[];
    sessionId?: string;
    dryRun?: boolean;
    autoApprove?: boolean;
    autoConfirm?: boolean;
    permissionPolicy?: string;
    executionMode?: PlanExecutionMode;
    approvedBy?: string;
    rollbackOnFailure?: boolean;
    fallbackToPlanOnUncertainty?: boolean;
    clientName?: string;
  };
  const { forceClient, error } = app.resolveForceClient(payload.clientName);
  if (error) return { status: 404, body: { error } };
  const planner = forceClient ? new Planner(app.makeChatFn(forceClient)) : app.planner;

  const workflow = new PlanActivationWorkflow({
    planService: app.planService,
    executeStoredPlan: (planId, version, execPayload, dryRun) =>
      app.orchestrator.executeStoredPlan(planId, version, execPayload, dryRun),
    planner,
  });

  try {
    return await workflow.activate({
      userVisiblePlanId,
      confirmedTodoIds: payload.confirmedTodoIds,
      sessionId: payload.sessionId,
      dryRun: payload.dryRun,
      autoApprove: payload.autoApprove,
      autoConfirm: payload.autoConfirm,
      permissionPolicy: parseUserPermissionPolicyValue(payload.permissionPolicy),
      executionMode: payload.executionMode,
      approvedBy: payload.approvedBy,
      rollbackOnFailure: payload.rollbackOnFailure,
      fallbackToPlanOnUncertainty: payload.fallbackToPlanOnUncertainty,
    });
  } catch (err) {
    if (err instanceof PlanValidationError) {
      const status = err.message.includes("不存在") ? 404 : 400;
      return { status, body: { error: err.message, code: err.code } };
    }
    return { status: 400, body: { error: String(err) } };
  }
}

export async function handlePlanPreview(app: AppContext, planId: string, url: URL): Promise<ApiResult> {
  const version = Number(url.searchParams.get("version") ?? "1");
  const format = (url.searchParams.get("format") ?? "markdown") as "markdown" | "json";
  if (format !== "markdown" && format !== "json") {
    return { status: 400, body: { error: "format 必须为 markdown 或 json" } };
  }
  const content = app.planService.getPreview(planId, version, format);
  if (!content) return { status: 404, body: { error: "预览不存在" } };
  return {
    status: 200,
    body: {
      planId,
      version,
      format,
      content,
      executable: false,
    },
  };
}

export async function handlePlanApprove(app: AppContext, planId: string, body: unknown): Promise<ApiResult> {
  const payload = (body ?? {}) as { version?: number; comment?: string; approvedBy?: string };
  const version = payload.version ?? 1;
  try {
    const internal = app.planService.approve(
      planId,
      version,
      payload.approvedBy?.trim() || "user",
      payload.comment,
    );
    return {
      status: 200,
      body: {
        planId,
        version,
        status: internal.status,
        planHash: internal.audit.planHash,
      },
    };
  } catch (err) {
    return { status: 400, body: { error: String(err) } };
  }
}

export async function handlePlanReject(app: AppContext, planId: string, body: unknown): Promise<ApiResult> {
  const payload = (body ?? {}) as { version?: number; comment?: string; rejectedBy?: string };
  const version = payload.version ?? 1;
  try {
    const internal = app.planService.reject(
      planId,
      version,
      payload.rejectedBy?.trim() || "user",
      payload.comment,
    );
    return {
      status: 200,
      body: {
        planId,
        version,
        status: internal.status,
        planHash: internal.audit.planHash,
      },
    };
  } catch (err) {
    return { status: 400, body: { error: String(err) } };
  }
}

export async function handlePlanCompile(app: AppContext, userVisiblePlanId: string, body: unknown): Promise<ApiResult> {
  const payload = (body ?? {}) as {
    confirmedTodoIds?: string[];
    sessionId?: string;
  };
  const confirmedTodoIds = Array.isArray(payload.confirmedTodoIds) ? payload.confirmedTodoIds : [];
  if (confirmedTodoIds.length === 0) {
    return { status: 400, body: { error: "confirmedTodoIds 不能为空" } };
  }
  try {
    return await new PlanCompileWorkflow({ planService: app.planService, planner: app.planner }).run({
      userVisiblePlanId,
      confirmedTodoIds,
      sessionId: payload.sessionId,
    });
  } catch (err) {
    if (err instanceof PlanValidationError) {
      const status = err.message.includes("不存在") ? 404 : 400;
      return { status, body: { error: err.message, code: err.code } };
    }
    return { status: 400, body: { error: String(err) } };
  }
}

export async function handlePlanExecute(app: AppContext, planId: string, body: unknown): Promise<ApiResult> {
  const payload = (body ?? {}) as Record<string, unknown>;
  const rejected = app.planService.rejectExecutionBody(payload);
  if (rejected) return { status: 400, body: rejected };

  const version = Number(payload.version ?? 0);
  if (!version || version < 1) {
    return { status: 400, body: { error: "version 必须为正整数", code: "MISSING_VERSION" } };
  }

  if (payload.plan !== undefined || payload.publicPlanJson !== undefined) {
    return {
      status: 400,
      body: {
        error: "执行 API 仅接受 planId + version，不可传入 plan / publicPlanJson",
        code: "PLAN_BODY_NOT_EXECUTABLE",
      },
    };
  }

  const executionMode =
    payload.executionMode === "agent_loop" || payload.executionMode === "static"
      ? payload.executionMode
      : undefined;

  return app.orchestrator.executeStoredPlan(
    planId,
    version,
    {
      autoConfirm: payload.autoConfirm as boolean | undefined,
      permissionPolicy: parseUserPermissionPolicyValue(payload.permissionPolicy as string | undefined),
      sessionId: payload.sessionId as string | undefined,
      rollbackOnFailure: payload.rollbackOnFailure as boolean | undefined,
      fallbackToPlanOnUncertainty: payload.fallbackToPlanOnUncertainty as boolean | undefined,
      executionMode,
    },
    Boolean(payload.dryRun),
  );
}

export async function handlePlanImportPreview(app: AppContext, body: unknown): Promise<ApiResult> {
  const payload = (body ?? {}) as {
    preview?: unknown;
    goal?: string;
    sessionId?: string;
    clientName?: string;
    planId?: string;
    baseVersion?: number;
  };
  if (payload.preview === undefined) {
    return { status: 400, body: { error: "preview 不能为空" } };
  }
  const { forceClient, error } = app.resolveForceClient(payload.clientName);
  if (error) return { status: 404, body: { error } };
  const planner = forceClient ? new Planner(app.makeChatFn(forceClient)) : app.planner;
  try {
    const draft = await app.planService.importPreviewAsRevision({
      preview: payload.preview,
      goal: payload.goal,
      sessionId: payload.sessionId,
      planId: payload.planId,
      baseVersion: payload.baseVersion,
      planner,
    });
    return { status: 200, body: draft };
  } catch (err) {
    if (err instanceof PlanValidationError) {
      return { status: 400, body: { error: err.message, code: err.code } };
    }
    return { status: 502, body: { error: String(err) } };
  }
}
