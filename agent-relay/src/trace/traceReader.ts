import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";

import { redactValue } from "../util/redact.js";
import type { TraceEvent } from "./TraceLogger.js";

export interface TraceReadOptions {
  limit?: number;
  redact?: boolean;
}

const DEFAULT_TAIL_CHUNK_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

function readTailLines(file: string, limit: number): string[] {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    let position = size;
    let text = "";
    let bytesReadTotal = 0;
    while (position > 0 && bytesReadTotal < MAX_TAIL_BYTES) {
      const chunkSize = Math.min(DEFAULT_TAIL_CHUNK_BYTES, position, MAX_TAIL_BYTES - bytesReadTotal);
      position -= chunkSize;
      const buf = Buffer.allocUnsafe(chunkSize);
      const bytesRead = readSync(fd, buf, 0, chunkSize, position);
      text = buf.subarray(0, bytesRead).toString("utf-8") + text;
      bytesReadTotal += bytesRead;
      const lines = text.split("\n").filter((line) => line.trim().length > 0);
      if (lines.length > limit) return lines.slice(-limit);
      if (bytesRead === 0) break;
    }
    return text.split("\n").filter((line) => line.trim().length > 0).slice(-limit);
  } finally {
    closeSync(fd);
  }
}

/** 读取 trace JSONL 尾部事件（用于导出 / 调试）。 */
export function readRecentTraceEvents(
  traceFile: string,
  options: TraceReadOptions = {},
): TraceEvent[] {
  const limit = options.limit ?? 50;
  const redact = options.redact !== false;
  if (!existsSync(traceFile)) return [];

  const slice = readTailLines(traceFile, limit);
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
