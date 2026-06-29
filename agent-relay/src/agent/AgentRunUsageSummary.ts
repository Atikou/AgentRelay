import type { TraceEvent } from "../trace/TraceLogger.js";
import type { AgentExecutionMeta, AgentRunMode } from "./RunPolicyTypes.js";
import type { AgentToolStep } from "./toolStep.js";
import { countToolOutcomeUsage, isFailedToolStep } from "./toolStepOutcome.js";

export interface AgentModelTurnMetric {
  iteration: number;
  success: boolean;
  client?: string;
  model?: string;
  location?: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  error?: string;
}

export interface AgentRunUsageSummaryInput {
  steps: AgentToolStep[];
  executionMeta: AgentExecutionMeta;
  modelTurnMetrics: AgentModelTurnMetric[];
  runId?: string;
  sessionId?: string;
  taskId?: string;
  mode: AgentRunMode;
}

export function buildRunUsageSummaryTracePayload(input: AgentRunUsageSummaryInput): TraceEvent {
  const inputTokens = sumOptional(input.modelTurnMetrics.map((m) => m.inputTokens));
  const outputTokens = sumOptional(input.modelTurnMetrics.map((m) => m.outputTokens));
  const costUsd = sumOptional(input.modelTurnMetrics.map((m) => m.costUsd));
  const modelLatencyMs = input.modelTurnMetrics.reduce((sum, m) => sum + m.latencyMs, 0);
  const modelErrors = input.modelTurnMetrics.filter((m) => !m.success);
  const outcomeUsage = countToolOutcomeUsage(input.steps);
  const failedTools = input.steps.filter((s) => isFailedToolStep(s));
  return {
    type: "run_usage_summary",
    runId: input.runId,
    sessionId: input.sessionId,
    taskId: input.taskId,
    mode: input.mode,
    status: input.executionMeta.stopReason,
    reachedLimit: input.executionMeta.stopReason === "budget_exhausted",
    budget: input.executionMeta.budget,
    usage: input.executionMeta.usage,
    modelTurns: input.modelTurnMetrics.length,
    modelSuccesses: input.modelTurnMetrics.filter((m) => m.success).length,
    modelErrors: modelErrors.length,
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens === undefined && outputTokens === undefined
        ? undefined
        : (inputTokens ?? 0) + (outputTokens ?? 0),
    modelLatencyMs,
    costUsd,
    toolCalls: input.steps.length,
    toolFailures: outcomeUsage.toolFailures,
    toolObservationFailures: outcomeUsage.toolObservationFailures,
    toolExecutionErrors: outcomeUsage.toolExecutionErrors,
    failedTools: failedTools.length,
    blockedTools: input.steps.filter((s) => s.blocked).length,
    errors: [
      ...modelErrors.map((m) => m.error).filter((e): e is string => Boolean(e)),
      ...failedTools.map((s) => s.error).filter((e): e is string => Boolean(e)),
    ].slice(0, 10),
  };
}

export function sumOptional(values: Array<number | undefined>): number | undefined {
  let seen = false;
  let sum = 0;
  for (const value of values) {
    if (value === undefined) continue;
    seen = true;
    sum += value;
  }
  return seen ? Number(sum.toFixed(6)) : undefined;
}
