import type { AppContext } from "../../app/createAppContext.js";
import type { ApiResult } from "../../orchestrator/Orchestrator.js";
import { buildRunReport, enrichRunReport } from "../../trace/runReport.js";

export function handleRunsList(app: AppContext, url: URL): ApiResult {
  const raw = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(1, raw), 200) : 50;
  const runs = app.orchestrator.listRuns(limit);
  return { status: 200, body: { runs, count: runs.length } };
}

export function handleRunGet(app: AppContext, id: string): ApiResult {
  const run = app.orchestrator.getRun(id);
  if (!run) return { status: 404, body: { error: "运行记录不存在" } };
  const runState = app.orchestrator.getRunState(id);
  return { status: 200, body: { run, runState: runState ?? undefined } };
}

export function handleRunCancel(app: AppContext, body: unknown): ApiResult {
  const payload = (body ?? {}) as { runId?: string };
  return app.orchestrator.cancelRun((payload.runId ?? "").trim());
}

export function handleRunsRunning(app: AppContext): ApiResult {
  return { status: 200, body: { running: app.orchestrator.listRunningAgentRuns() } };
}

export async function handleRunReport(app: AppContext, id: string): Promise<ApiResult> {
  const run = app.orchestrator.getRun(id);
  if (!run) return { status: 404, body: { error: "运行记录不存在" } };
  const base = await buildRunReport(app.paths.traceFile, id, 500, app.traceCatalog);
  if (!base) {
    return { status: 404, body: { error: "未找到该 Run 的 trace 事件", runId: id } };
  }

  const routeLogs = run.sessionId
    ? app.routeLogStore.listRecent(50, run.sessionId)
    : [];
  const fallbackLogs = run.sessionId
    ? app.fallbackLogStore.listBySession(run.sessionId, 50)
    : [];

  const report = enrichRunReport(base, {
    sessionId: run.sessionId,
    runCreatedAt: run.createdAt,
    runUpdatedAt: run.updatedAt,
    routeLogs,
    fallbackLogs,
  });

  return { status: 200, body: { run, report } };
}

export function handleRunDelete(app: AppContext, id: string): ApiResult {
  const trimmed = id.trim();
  if (!trimmed) return { status: 400, body: { error: "runId 不能为空" } };

  const running = app.orchestrator.listRunningAgentRuns();
  if (running.some((r) => r.runId === trimmed)) {
    return { status: 409, body: { error: "运行中的 Run 不能删除", runId: trimmed } };
  }

  const run = app.orchestrator.getRun(trimmed);
  if (!run) return { status: 404, body: { error: "运行记录不存在", runId: trimmed } };

  app.runStateStore.delete(trimmed);
  const dbDeleted = app.runs.delete(trimmed);
  if (!dbDeleted) return { status: 404, body: { error: "运行记录不存在", runId: trimmed } };

  const artifacts = app.dataLifecycle.onRunDeleted(trimmed, run.sessionId);
  return {
    status: 200,
    body: {
      runId: trimmed,
      deleted: true,
      sessionId: run.sessionId,
      artifactsBytesFreed: artifacts.bytesFreed,
      timelineDir: artifacts.timelineDir,
      dataRunDir: artifacts.dataRunDir,
    },
  };
}
