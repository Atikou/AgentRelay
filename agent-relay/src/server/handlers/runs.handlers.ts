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
  return { status: 200, body: { run } };
}

export async function handleRunReport(app: AppContext, id: string): Promise<ApiResult> {
  const run = app.orchestrator.getRun(id);
  if (!run) return { status: 404, body: { error: "运行记录不存在" } };
  const base = await buildRunReport(app.paths.traceFile, id);
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
