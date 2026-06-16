import type { AppContext } from "../../app/createAppContext.js";
import type { ApiResult } from "../../orchestrator/Orchestrator.js";
import type { CleanupApplyRequest, CleanupPreviewRequest } from "../../lifecycle/types.js";
import { findRunIdsForSession } from "../../lifecycle/SessionArtifactCleaner.js";

export interface SessionPurgeRequest {
  confirm?: boolean;
}

export function handleStorageUsage(app: AppContext): ApiResult {
  return { status: 200, body: app.dataLifecycle.getUsage() };
}

export function handleStorageCleanupRuns(app: AppContext, url: URL): ApiResult {
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
  return { status: 200, body: { runs: app.dataLifecycle.listCleanupRuns(limit) } };
}

export function handleStorageCleanupPreview(app: AppContext, body: unknown): ApiResult {
  const payload = (body ?? {}) as CleanupPreviewRequest;
  const report = app.dataLifecycle.preview(payload);
  return { status: 200, body: report };
}

export function handleStorageCleanupApply(app: AppContext, body: unknown): ApiResult {
  const payload = (body ?? {}) as CleanupApplyRequest;
  if (!payload.cleanupRunId) {
    return { status: 400, body: { error: "cleanupRunId 不能为空" } };
  }
  const result = app.dataLifecycle.apply(payload);
  if ("error" in result) {
    return { status: result.status, body: { error: result.error } };
  }
  return { status: 200, body: result };
}

export function handleContextSessionDeleteWithLifecycle(app: AppContext, id: string): ApiResult {
  const runIds = findRunIdsForSession(app.contextManager.db, id);
  const ok = app.contextManager.deleteSession(id);
  if (!ok) return { status: 404, body: { error: "会话不存在", sessionId: id } };
  const artifacts = app.dataLifecycle.onSessionDeleted(id, runIds);
  return {
    status: 200,
    body: {
      sessionId: id,
      deleted: true,
      runIds: artifacts.runIds,
      artifactsBytesFreed: artifacts.bytesFreed,
    },
  };
}

export function handleContextSessionPurge(app: AppContext, id: string, body: unknown): ApiResult {
  const payload = (body ?? {}) as SessionPurgeRequest;
  if (!payload.confirm) {
    return {
      status: 400,
      body: {
        error: "隐私清除需要 confirm: true",
        hint: "将删除会话及 trace/tools/routing 中关联详细记录，不可恢复",
      },
    };
  }

  if (!app.contextManager.getSession(id)) {
    return { status: 404, body: { error: "会话不存在", sessionId: id } };
  }

  const runIds = findRunIdsForSession(app.contextManager.db, id);
  const active = new Set(app.orchestrator.listRunningAgentRuns().map((r) => r.runId));
  if (runIds.some((runId) => active.has(runId))) {
    return { status: 409, body: { error: "会话有关联运行中的 Run，无法隐私清除", sessionId: id } };
  }

  app.trace.rotate({ force: true });

  const ok = app.contextManager.deleteSession(id);
  if (!ok) return { status: 404, body: { error: "会话不存在", sessionId: id } };

  try {
    const result = app.dataLifecycle.purgeSessionPrivacy(id, runIds);
    return { status: 200, body: { deleted: true, purge: result } };
  } catch (error) {
    return { status: 500, body: { error: String(error), sessionId: id } };
  }
}
