import type { AppContext } from "../../app/createAppContext.js";
import type { ApiResult } from "../../orchestrator/Orchestrator.js";
import { buildRunTimeline } from "../../trace/runReport.js";
import { readRecentTraceEvents } from "../../trace/traceReader.js";
import {
  parseTraceQueryFilter,
  scanTraceEvents,
  serializeTraceQueryFilter,
  summarizeTraceEvents,
} from "../../trace/traceQuery.js";

function traceReadOpts(app: AppContext) {
  return { catalog: app.traceCatalog };
}

function parseLimit(url: URL, fallback: number, max: number): number {
  const raw = Number(url.searchParams.get("limit") ?? fallback);
  return Number.isFinite(raw) ? Math.min(Math.max(1, raw), max) : fallback;
}

export function handleTraceRecent(app: AppContext, url: URL): ApiResult {
  const limit = parseLimit(url, 50, 200);
  const events = readRecentTraceEvents(app.paths.traceFile, { limit, redact: true, ...traceReadOpts(app) });
  return { status: 200, body: { events, count: events.length, redacted: true } };
}

export async function handleTraceExport(app: AppContext, url: URL): Promise<ApiResult> {
  const limit = parseLimit(url, 500, 2000);
  const filter = parseTraceQueryFilter(url);
  filter.replayOnly = url.searchParams.get("replayOnly") === "true" ? true : filter.replayOnly;
  const events = await scanTraceEvents(app.paths.traceFile, {
    limit,
    redact: true,
    filter,
    catalog: app.traceCatalog,
  });
  return {
    status: 200,
    body: {
      exportedAt: new Date().toISOString(),
      count: events.length,
      redacted: true,
      filters: serializeTraceQueryFilter(filter),
      summary: summarizeTraceEvents(events),
      timeline: buildRunTimeline(events),
      events,
    },
  };
}

export async function handleTraceReplay(app: AppContext, url: URL): Promise<ApiResult> {
  const limit = parseLimit(url, 100, 500);
  const filter = parseTraceQueryFilter(url);
  const events = await scanTraceEvents(app.paths.traceFile, {
    limit,
    redact: true,
    filter,
    catalog: app.traceCatalog,
  });
  return {
    status: 200,
    body: {
      events,
      count: events.length,
      redacted: true,
      replay: true,
      filters: serializeTraceQueryFilter(filter),
      summary: summarizeTraceEvents(events),
      timeline: buildRunTimeline(events),
    },
  };
}

export function handleTraceRotate(app: AppContext): ApiResult {
  const result = app.trace.rotate({ force: true });
  return {
    status: 200,
    body: {
      rotated: result.rotated,
      segmentPath: result.segmentPath,
      activeFile: app.paths.traceFile,
      indexEntries: app.trace.getIndexStore()?.count() ?? 0,
    },
  };
}
