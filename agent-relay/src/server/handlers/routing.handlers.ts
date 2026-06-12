import type { AppContext } from "../../app/createAppContext.js";
import type { ApiResult } from "../../orchestrator/Orchestrator.js";

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
