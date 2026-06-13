import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";

import { redactValue } from "../util/redact.js";
import type { TraceEvent } from "./TraceLogger.js";

/** 审计回放默认包含的事件类型（过滤 model_call 等噪声）。 */
export const REPLAY_EVENT_TYPES = new Set([
  "run_start",
  "run_end",
  "agent_decision",
  "agent_model_turn",
  "run_usage_summary",
  "task_status_change",
  "tool_audit",
  "agent_tool",
  "scheduler_fire",
  "task_step",
  "background_start",
  "background_done",
  "background_trigger_next",
  "subagent_start",
  "subagent_end",
]);

export type TraceReplayCategory =
  | "run"
  | "model"
  | "tool"
  | "agent"
  | "task"
  | "background"
  | "subagent"
  | "scheduler";

export const TRACE_CATEGORY_TYPES: Record<TraceReplayCategory, readonly string[]> = {
  run: ["run_start", "run_end"],
  model: ["agent_model_turn", "run_usage_summary"],
  tool: ["agent_tool", "tool_audit"],
  agent: ["agent_decision"],
  task: ["task_step", "task_status_change"],
  background: ["background_start", "background_done", "background_trigger_next"],
  subagent: ["subagent_start", "subagent_end"],
  scheduler: ["scheduler_fire"],
};

export interface TraceQueryFilter {
  runId?: string;
  sessionId?: string;
  taskId?: string;
  toolCallId?: string;
  type?: string;
  types?: string[];
  category?: TraceReplayCategory;
  replayOnly?: boolean;
}

export interface ScanTraceOptions {
  limit?: number;
  maxScanLines?: number;
  redact?: boolean;
  filter?: TraceQueryFilter;
}

export interface TraceQuerySummary {
  types: Record<string, number>;
  toolCallIds: string[];
  runIds: string[];
  sessionIds: string[];
}

const DEFAULT_MAX_SCAN_LINES = 20_000;

export function parseTraceReplayCategory(raw: string | null): TraceReplayCategory | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "run" ||
    normalized === "model" ||
    normalized === "tool" ||
    normalized === "agent" ||
    normalized === "task" ||
    normalized === "background" ||
    normalized === "subagent" ||
    normalized === "scheduler"
  ) {
    return normalized;
  }
  return undefined;
}

export function parseTraceQueryFilter(url: URL): TraceQueryFilter {
  const typesRaw = url.searchParams.get("types");
  const types = typesRaw
    ? typesRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const replayOnlyParam = url.searchParams.get("replayOnly");
  return {
    runId: url.searchParams.get("runId")?.trim() || undefined,
    sessionId: url.searchParams.get("sessionId")?.trim() || undefined,
    taskId: url.searchParams.get("taskId")?.trim() || undefined,
    toolCallId: url.searchParams.get("toolCallId")?.trim() || undefined,
    type: url.searchParams.get("type")?.trim() || undefined,
    types: types?.length ? types : undefined,
    category: parseTraceReplayCategory(url.searchParams.get("category")),
    replayOnly: replayOnlyParam == null ? true : replayOnlyParam !== "false",
  };
}

export function serializeTraceQueryFilter(filter: TraceQueryFilter): Record<string, string | boolean | string[]> {
  const out: Record<string, string | boolean | string[]> = {};
  if (filter.runId) out.runId = filter.runId;
  if (filter.sessionId) out.sessionId = filter.sessionId;
  if (filter.taskId) out.taskId = filter.taskId;
  if (filter.toolCallId) out.toolCallId = filter.toolCallId;
  if (filter.type) out.type = filter.type;
  if (filter.types?.length) out.types = filter.types;
  if (filter.category) out.category = filter.category;
  if (filter.replayOnly === false) out.replayOnly = false;
  return out;
}

function hasScopedFilter(filter?: TraceQueryFilter): boolean {
  if (!filter) return false;
  return !!(filter.runId || filter.sessionId || filter.taskId || filter.toolCallId || filter.type || filter.types?.length || filter.category);
}

function allowedTypes(filter?: TraceQueryFilter): Set<string> | undefined {
  const sets: Set<string>[] = [];
  if (filter?.type) sets.push(new Set([filter.type]));
  if (filter?.types?.length) sets.push(new Set(filter.types));
  if (filter?.category) sets.push(new Set(TRACE_CATEGORY_TYPES[filter.category]));
  if (filter?.replayOnly !== false) sets.push(REPLAY_EVENT_TYPES);
  if (sets.length === 0) return undefined;
  let result = sets[0]!;
  for (let i = 1; i < sets.length; i++) {
    result = new Set([...result].filter((t) => sets[i]!.has(t)));
  }
  return result;
}

export function matchesTraceFilter(event: TraceEvent, filter?: TraceQueryFilter): boolean {
  if (!filter) return true;
  const e = event as Record<string, unknown>;
  if (filter.runId && e.runId !== filter.runId) return false;
  if (filter.sessionId && e.sessionId !== filter.sessionId) return false;
  if (filter.taskId && e.taskId !== filter.taskId) return false;
  if (filter.toolCallId && e.toolCallId !== filter.toolCallId) return false;

  const type = String(e.type ?? "");
  const allowed = allowedTypes(filter);
  if (allowed && !allowed.has(type)) return false;
  return true;
}

export function summarizeTraceEvents(events: TraceEvent[]): TraceQuerySummary {
  const types: Record<string, number> = {};
  const toolCallIds = new Set<string>();
  const runIds = new Set<string>();
  const sessionIds = new Set<string>();

  for (const event of events) {
    const e = event as Record<string, unknown>;
    const type = String(e.type ?? "unknown");
    types[type] = (types[type] ?? 0) + 1;
    if (typeof e.toolCallId === "string" && e.toolCallId) toolCallIds.add(e.toolCallId);
    if (typeof e.runId === "string" && e.runId) runIds.add(e.runId);
    if (typeof e.sessionId === "string" && e.sessionId) sessionIds.add(e.sessionId);
  }

  return {
    types,
    toolCallIds: [...toolCallIds],
    runIds: [...runIds],
    sessionIds: [...sessionIds],
  };
}

/** 扫描 trace 文件并按过滤条件收集事件；有 scope 过滤时全文件扫描，否则读尾部。 */
export async function scanTraceEvents(
  traceFile: string,
  options: ScanTraceOptions = {},
): Promise<TraceEvent[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 2000);
  const redact = options.redact !== false;
  const filter = options.filter;
  const maxScanLines = options.maxScanLines ?? DEFAULT_MAX_SCAN_LINES;

  if (!existsSync(traceFile)) return [];

  if (!hasScopedFilter(filter)) {
    const { readRecentTraceEvents } = await import("./traceReader.js");
    const raw = readRecentTraceEvents(traceFile, {
      limit: filter?.replayOnly === false ? limit : limit * 3,
      redact: false,
    });
    const matched = raw.filter((e) => matchesTraceFilter(e, filter));
    const sliced = matched.slice(-limit);
    return redact ? sliced.map((e) => redactValue(e)) : sliced;
  }

  const matched: TraceEvent[] = [];
  const rl = createInterface({ input: createReadStream(traceFile, { encoding: "utf-8" }) });
  let scanned = 0;

  for await (const line of rl) {
    scanned += 1;
    if (scanned > maxScanLines) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as TraceEvent;
      if (!matchesTraceFilter(parsed, filter)) continue;
      matched.push(redact ? redactValue(parsed) : parsed);
      if (matched.length > limit * 4) matched.splice(0, matched.length - limit * 2);
    } catch {
      // skip corrupt line
    }
  }

  return matched.slice(-limit);
}
