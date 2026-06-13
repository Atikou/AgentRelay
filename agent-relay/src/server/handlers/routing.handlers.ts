import type { AppContext } from "../../app/createAppContext.js";
import type { ApiResult } from "../../orchestrator/Orchestrator.js";
import type { EvalSetCase, EvalSetScope } from "../../model-router/eval-set-runner.js";
import { RuntimeStatsCollector } from "../../model-router/runtime-stats.js";

export function handleRoutingLogs(app: AppContext, url: URL): ApiResult {
  const routeLogId = url.searchParams.get("routeLogId") ?? undefined;
  const sessionId = url.searchParams.get("sessionId") ?? undefined;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "20") || 20));

  if (routeLogId) {
    const route = app.routeLogStore.get(routeLogId);
    if (!route) {
      return { status: 404, body: { error: "路由记录不存在" } };
    }
    return {
      status: 200,
      body: {
        route,
        calls: app.modelCallLogStore.listByRoute(routeLogId),
        collaborations: app.collaborationRunStore.listByRoute(routeLogId),
        fallbacks: app.fallbackLogStore.listByRoute(routeLogId),
      },
    };
  }

  return {
    status: 200,
    body: {
      routes: app.routeLogStore.listRecent(limit, sessionId),
    },
  };
}

export function handleRoutingStats(app: AppContext, url: URL): ApiResult {
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? "200") || 200));
  const collector = new RuntimeStatsCollector(
    app.contextManager.db.connection,
    app.metrics,
  );
  return {
    status: 200,
    body: collector.snapshot({ routeLimit: limit }),
  };
}

export function handleRoutingEvalRuns(app: AppContext, url: URL): ApiResult {
  const runId = url.searchParams.get("runId") ?? undefined;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "20") || 20));

  if (runId) {
    const detail = app.modelEvalStore.getRun(runId);
    if (!detail) {
      return { status: 404, body: { error: "评测运行记录不存在" } };
    }
    return { status: 200, body: detail };
  }

  return {
    status: 200,
    body: { runs: app.modelEvalStore.listRuns(limit) },
  };
}

export function handleRoutingEvalRun(app: AppContext, body: unknown): ApiResult {
  const payload = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const scopeRaw = payload.scope;
  const scope: EvalSetScope = scopeRaw === "smart" ? "smart" : "rule";
  const setName = typeof payload.setName === "string" ? payload.setName.trim() : undefined;
  const persist = payload.persist === false ? false : true;
  const cases = Array.isArray(payload.cases) ? (payload.cases as EvalSetCase[]) : undefined;

  try {
    const summary = app.evalSetRunner.run({
      scope,
      setName,
      cases,
      persist,
    });
    return { status: 200, body: summary };
  } catch (error) {
    return {
      status: 400,
      body: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}
