import { existsSync, readFileSync } from "node:fs";

import { redactValue } from "../util/redact.js";
import type { TraceEvent } from "./TraceLogger.js";

export interface TraceReadOptions {
  limit?: number;
  redact?: boolean;
}

/** 读取 trace JSONL 尾部事件（用于导出 / 调试）。 */
export function readRecentTraceEvents(
  traceFile: string,
  options: TraceReadOptions = {},
): TraceEvent[] {
  const limit = options.limit ?? 50;
  const redact = options.redact !== false;
  if (!existsSync(traceFile)) return [];

  const content = readFileSync(traceFile, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  const slice = lines.slice(-limit);
  const events: TraceEvent[] = [];
  for (const line of slice) {
    try {
      const parsed = JSON.parse(line) as TraceEvent;
      events.push(redact ? redactValue(parsed) : parsed);
    } catch {
      // 跳过损坏行
    }
  }
  return events;
}

const REPLAY_EVENT_TYPES = new Set([
  "tool_audit",
  "agent_tool",
  "scheduler_fire",
  "task_step",
  "background_start",
  "background_done",
  "subagent_start",
  "subagent_end",
]);

/** 读取可回放审计链路（过滤模型调用等噪声事件）。 */
export function readReplayTraceEvents(
  traceFile: string,
  options: TraceReadOptions = {},
): TraceEvent[] {
  const limit = options.limit ?? 100;
  const events = readRecentTraceEvents(traceFile, { ...options, limit: limit * 3 });
  const filtered = events.filter((e) => REPLAY_EVENT_TYPES.has(String(e.type)));
  return filtered.slice(-limit);
}
