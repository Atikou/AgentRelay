import type { AppContext } from "../../app/createAppContext.js";
import type { ApiResult } from "../../orchestrator/Orchestrator.js";
import { readRecentTraceEvents, readReplayTraceEvents } from "../../trace/traceReader.js";

export function handleTraceRecent(app: AppContext, url: URL): ApiResult {
  const raw = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(1, raw), 200) : 50;
  const events = readRecentTraceEvents(app.paths.traceFile, { limit, redact: true });
  return { status: 200, body: { events, count: events.length, redacted: true } };
}

export function handleTraceExport(app: AppContext, url: URL): ApiResult {
  const raw = Number(url.searchParams.get("limit") ?? 500);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(1, raw), 2000) : 500;
  const events = readRecentTraceEvents(app.paths.traceFile, { limit, redact: true });
  return {
    status: 200,
    body: { exportedAt: new Date().toISOString(), count: events.length, redacted: true, events },
  };
}

export function handleTraceReplay(app: AppContext, url: URL): ApiResult {
  const raw = Number(url.searchParams.get("limit") ?? 100);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(1, raw), 500) : 100;
  const events = readReplayTraceEvents(app.paths.traceFile, { limit, redact: true });
  return { status: 200, body: { events, count: events.length, redacted: true, replay: true } };
}
