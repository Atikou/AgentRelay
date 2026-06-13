import type { AppContext } from "../../app/createAppContext.js";
import type { ApiResult } from "../../orchestrator/Orchestrator.js";
import { Planner } from "../../agent/Planner.js";
import { PlanValidationError } from "../../plan/index.js";
import { detectPlanReportRequest } from "../../plan/planIntent.js";
import { buildPlanAnalysisPrompt, renderUserVisiblePlan } from "../../plan/UserPlanRenderer.js";
import type { PlanMode } from "../../plan/types.js";
import type { RunBudget } from "../../agent/RunPolicyTypes.js";

export async function handlePlanDraft(app: AppContext, body: unknown): Promise<ApiResult> {
  const payload = (body ?? {}) as {
    goal?: string;
    context?: string;
    sessionId?: string;
    mode?: PlanMode;
    clientName?: string;
  };
  const goal = (payload.goal ?? "").trim();
  if (!goal) return { status: 400, body: { error: "goal 不能为空" } };
  const reportRequest = detectPlanReportRequest(goal);
  if (reportRequest) return { status: 400, body: reportRequest };

  const { forceClient, error } = app.resolveForceClient(payload.clientName);
  if (error) return { status: 404, body: { error } };
  const planner = forceClient ? new Planner(app.makeChatFn(forceClient)) : app.planner;

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
  };
  const goal = (payload.goal ?? "").trim();
  if (!goal) return { status: 400, body: { error: "goal 不能为空" } };

  const { forceClient, error } = app.resolveForceClient(payload.clientName);
  if (error) return { status: 404, body: { error } };
  const makeChat = forceClient ? app.makeChatFn(forceClient) : undefined;
  const result = await app.orchestrator.runAgent(
    {
      message: buildPlanAnalysisPrompt({ goal, context: payload.context }),
      mode: "plan",
      sessionId: payload.sessionId,
      clientName: payload.clientName,
      autoConfirm: false,
      sensitive: true,
      budget: payload.budget,
    },
    makeChat,
  );
  if (result.status !== 200) return result;

  const body200 = result.body as {
    runId?: string;
    sessionId?: string;
    answer?: string;
    executionMeta?: unknown;
  };
  const userVisiblePlan = app.planService.saveUserVisiblePlan(
    renderUserVisiblePlan({
      sourceRunId: body200.runId ?? "unknown-run",
      sessionId: body200.sessionId ?? payload.sessionId,
      goal,
      markdown: body200.answer ?? "",
    }),
  );
  return {
    status: 200,
    body: {
      userVisiblePlan,
      executionMeta: body200.executionMeta,
      runId: body200.runId,
      warning: "UserVisiblePlan 仅供用户审阅，不能直接执行；执行前请 compile → approve → execute。",
    },
  };
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
    const draft = app.planService.compileUserVisiblePlan({
      userVisiblePlanId,
      confirmedTodoIds,
      sessionId: payload.sessionId,
    });
    return {
      status: 200,
      body: {
        planId: draft.planId,
        version: draft.version,
        status: draft.status,
        planHash: draft.planHash,
        previewMarkdown: draft.previewMarkdown,
        publicPlanJson: draft.publicPlanJson,
        sourceUserVisiblePlanId: draft.sourceUserVisiblePlan.id,
        warning: "编译结果为待审批 ExecutableTaskPlan 草案，仍需 approve 后才能 execute。",
      },
    };
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

  return app.orchestrator.executeStoredPlan(
    planId,
    version,
    {
      autoConfirm: payload.autoConfirm as boolean | undefined,
      sessionId: payload.sessionId as string | undefined,
      rollbackOnFailure: payload.rollbackOnFailure as boolean | undefined,
      fallbackToPlanOnUncertainty: payload.fallbackToPlanOnUncertainty as boolean | undefined,
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
