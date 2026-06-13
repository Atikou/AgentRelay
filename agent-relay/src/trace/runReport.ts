import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";

import { redactValue } from "../util/redact.js";
import type { TraceEvent } from "./TraceLogger.js";

export interface RunUsageReport {
  modelTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  toolCalls: number;
  toolFailures: number;
}

export interface RunReport {
  runId: string;
  eventCount: number;
  events: TraceEvent[];
  usage: RunUsageReport;
}

function accumulateUsage(events: TraceEvent[]): RunUsageReport {
  const usage: RunUsageReport = {
    modelTurns: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    toolCalls: 0,
    toolFailures: 0,
  };

  for (const event of events) {
    const e = event as Record<string, unknown>;
    if (e.type === "agent_model_turn") {
      usage.modelTurns += 1;
      usage.totalInputTokens += Number(e.inputTokens ?? 0);
      usage.totalOutputTokens += Number(e.outputTokens ?? 0);
      usage.totalCostUsd += Number(e.costUsd ?? 0);
    }
    if (e.type === "agent_tool" || e.type === "tool_audit") {
      usage.toolCalls += 1;
      if (e.success === false || e.ok === false) usage.toolFailures += 1;
    }
    if (e.type === "run_usage_summary") {
      usage.modelTurns = Number(e.modelTurns ?? usage.modelTurns);
      usage.totalInputTokens = Number(e.totalInputTokens ?? usage.totalInputTokens);
      usage.totalOutputTokens = Number(e.totalOutputTokens ?? usage.totalOutputTokens);
      usage.totalCostUsd = Number(e.totalCostUsd ?? usage.totalCostUsd);
      usage.toolCalls = Number(e.toolCalls ?? usage.toolCalls);
      usage.toolFailures = Number(e.toolFailures ?? usage.toolFailures);
    }
  }

  return usage;
}

/** 扫描 trace 文件，收集指定 runId 的事件（上限 maxEvents 条）。 */
export async function buildRunReport(
  traceFile: string,
  runId: string,
  maxEvents = 500,
): Promise<RunReport | null> {
  if (!existsSync(traceFile)) return null;

  const events: TraceEvent[] = [];
  const rl = createInterface({ input: createReadStream(traceFile, { encoding: "utf-8" }) });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as TraceEvent & { runId?: string };
      if (parsed.runId !== runId) continue;
      events.push(redactValue(parsed));
      if (events.length >= maxEvents) break;
    } catch {
      // skip corrupt line
    }
  }

  if (events.length === 0) return null;

  return {
    runId,
    eventCount: events.length,
    events,
    usage: accumulateUsage(events),
  };
}
