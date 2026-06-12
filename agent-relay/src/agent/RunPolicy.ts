import { MODE_PERMISSIONS, type ToolPermission } from "./permissions.js";
import type { ModelTaskType } from "../model/taskType.js";

export type AgentRunMode = "chat" | "plan" | "implement" | "debug" | "review";

export type AgentStopReason = "completed" | "budget_exhausted" | "error" | "user_cancelled";

export interface RunBudget {
  maxModelTurns: number;
  maxToolCalls: number;
  maxReadCalls: number;
  maxWriteCalls: number;
  maxShellCalls: number;
  maxRuntimeMs: number;
}

export interface RunBudgetUsage {
  modelTurns: number;
  toolCalls: number;
  readCalls: number;
  writeCalls: number;
  shellCalls: number;
  runtimeMs: number;
}

export type RunBudgetKey = keyof RunBudget;

export interface LocationExecutionMeta {
  usedLocateSteps: number;
  usedSearchCalls: number;
  usedListCalls: number;
  usedReadForLocationCalls: number;
  locatedFiles: string[];
  candidateFiles: string[];
  stopReason?: string;
  needsContinue: boolean;
  confidence?: number;
}

export interface AgentExecutionMeta {
  mode: AgentRunMode;
  budget: RunBudget;
  usage: RunBudgetUsage;
  budgetExhausted?: RunBudgetKey;
  location?: LocationExecutionMeta;
  usedIterations: number;
  usedModelTurns: number;
  usedToolCalls: number;
  usedReadCalls: number;
  usedWriteCalls: number;
  usedShellCalls: number;
  stopReason: AgentStopReason;
  needsMoreBudget: boolean;
  suggestedBudget?: RunBudget;
}

export interface RunPolicy {
  mode: AgentRunMode;
  budget: RunBudget;
  allowedPermissions: ToolPermission[];
  requireFinalAnswer: boolean;
  allowPartialAnswer: boolean;
  suggestedBudget: RunBudget;
  systemHint: string;
}

const MODE_DEFAULT_BUDGETS: Record<AgentRunMode, RunBudget> = {
  chat: {
    maxModelTurns: 8,
    maxToolCalls: 8,
    maxReadCalls: 6,
    maxWriteCalls: 2,
    maxShellCalls: 2,
    maxRuntimeMs: 120_000,
  },
  plan: {
    maxModelTurns: 16,
    maxToolCalls: 20,
    maxReadCalls: 20,
    maxWriteCalls: 0,
    maxShellCalls: 0,
    maxRuntimeMs: 180_000,
  },
  implement: {
    maxModelTurns: 24,
    maxToolCalls: 40,
    maxReadCalls: 24,
    maxWriteCalls: 12,
    maxShellCalls: 10,
    maxRuntimeMs: 300_000,
  },
  debug: {
    maxModelTurns: 20,
    maxToolCalls: 36,
    maxReadCalls: 18,
    maxWriteCalls: 4,
    maxShellCalls: 14,
    maxRuntimeMs: 300_000,
  },
  review: {
    maxModelTurns: 16,
    maxToolCalls: 20,
    maxReadCalls: 20,
    maxWriteCalls: 0,
    maxShellCalls: 0,
    maxRuntimeMs: 180_000,
  },
};

const MODE_SUGGESTED_BUDGETS: Record<AgentRunMode, RunBudget> = {
  chat: {
    maxModelTurns: 8,
    maxToolCalls: 8,
    maxReadCalls: 6,
    maxWriteCalls: 2,
    maxShellCalls: 2,
    maxRuntimeMs: 120_000,
  },
  plan: {
    maxModelTurns: 16,
    maxToolCalls: 20,
    maxReadCalls: 20,
    maxWriteCalls: 0,
    maxShellCalls: 0,
    maxRuntimeMs: 180_000,
  },
  implement: {
    maxModelTurns: 24,
    maxToolCalls: 40,
    maxReadCalls: 24,
    maxWriteCalls: 12,
    maxShellCalls: 10,
    maxRuntimeMs: 300_000,
  },
  debug: {
    maxModelTurns: 24,
    maxToolCalls: 42,
    maxReadCalls: 22,
    maxWriteCalls: 6,
    maxShellCalls: 16,
    maxRuntimeMs: 360_000,
  },
  review: {
    maxModelTurns: 16,
    maxToolCalls: 20,
    maxReadCalls: 20,
    maxWriteCalls: 0,
    maxShellCalls: 0,
    maxRuntimeMs: 180_000,
  },
};

const MODE_PERMISSIONS_BY_RUN_MODE: Record<AgentRunMode, ToolPermission[]> = {
  chat: MODE_PERMISSIONS.task,
  plan: MODE_PERMISSIONS.plan,
  implement: MODE_PERMISSIONS.task,
  debug: MODE_PERMISSIONS.task,
  review: MODE_PERMISSIONS.plan,
};

export interface ResolveRunPolicyInput {
  requestedMode?: string;
  budget?: Partial<RunBudget>;
  taskType?: ModelTaskType;
  message?: string;
}

export function resolveRunPolicy(input: ResolveRunPolicyInput = {}): RunPolicy {
  const mode = parseRunMode(input.requestedMode) ?? inferRunMode(input);
  const budget = resolveBudget(mode, input.budget);
  const suggestedBudget = mergeBudgetMax(MODE_SUGGESTED_BUDGETS[mode], budget);

  return {
    mode,
    budget,
    allowedPermissions: [...MODE_PERMISSIONS_BY_RUN_MODE[mode]],
    requireFinalAnswer: true,
    allowPartialAnswer: true,
    suggestedBudget,
    systemHint: buildSystemHint(mode),
  };
}

export function parseRunMode(mode: string | undefined): AgentRunMode | undefined {
  if (!mode) return undefined;
  const normalized = mode.trim().toLowerCase();
  if (
    normalized === "chat" ||
    normalized === "plan" ||
    normalized === "implement" ||
    normalized === "debug" ||
    normalized === "review"
  ) {
    return normalized;
  }
  return undefined;
}

function normalizeBudgetValue(value: number | undefined, max: number): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  if (n <= 0) return undefined;
  return Math.min(n, max);
}

function resolveBudget(mode: AgentRunMode, override: Partial<RunBudget> | undefined): RunBudget {
  const base = MODE_DEFAULT_BUDGETS[mode];
  return {
    maxModelTurns: normalizeBudgetValue(override?.maxModelTurns, 60) ?? base.maxModelTurns,
    maxToolCalls: normalizeBudgetValue(override?.maxToolCalls, 200) ?? base.maxToolCalls,
    maxReadCalls: normalizeBudgetValue(override?.maxReadCalls, 200) ?? base.maxReadCalls,
    maxWriteCalls: normalizeBudgetValue(override?.maxWriteCalls, 100) ?? base.maxWriteCalls,
    maxShellCalls: normalizeBudgetValue(override?.maxShellCalls, 100) ?? base.maxShellCalls,
    maxRuntimeMs: normalizeBudgetValue(override?.maxRuntimeMs, 1_800_000) ?? base.maxRuntimeMs,
  };
}

function mergeBudgetMax(base: RunBudget, budget: RunBudget): RunBudget {
  return {
    maxModelTurns: Math.max(base.maxModelTurns, budget.maxModelTurns),
    maxToolCalls: Math.max(base.maxToolCalls, budget.maxToolCalls),
    maxReadCalls: Math.max(base.maxReadCalls, budget.maxReadCalls),
    maxWriteCalls: Math.max(base.maxWriteCalls, budget.maxWriteCalls),
    maxShellCalls: Math.max(base.maxShellCalls, budget.maxShellCalls),
    maxRuntimeMs: Math.max(base.maxRuntimeMs, budget.maxRuntimeMs),
  };
}

function inferRunMode(input: ResolveRunPolicyInput): AgentRunMode {
  const text = input.message?.toLowerCase() ?? "";
  if (
    text.includes("计划模式") ||
    text.includes("只读") ||
    text.includes("不要修改") ||
    text.includes("不做修改") ||
    text.includes("先不要修改") ||
    text.includes("plan mode")
  ) {
    return "plan";
  }
  if (text.includes("审阅") || text.includes("review")) return "review";
  if (text.includes("调试") || text.includes("排错") || text.includes("debug")) return "debug";
  if (input.taskType === "codegen") return "implement";
  return "chat";
}

function buildSystemHint(mode: AgentRunMode): string {
  if (mode === "plan") {
    return [
      "当前运行模式：plan（计划/只读分析）。",
      "执行层只暴露 read 权限工具；禁止写文件、打补丁、执行命令或任何副作用操作。",
      "如果预算不足，必须基于已获得的信息输出部分分析、缺失信息和继续建议。",
    ].join("\n");
  }
  if (mode === "review") {
    return [
      "当前运行模式：review（审阅/只读）。",
      "执行层只暴露 read 权限工具；请优先指出问题、风险和证据，不修改文件。",
    ].join("\n");
  }
  if (mode === "debug") {
    return "当前运行模式：debug。请先定位证据，再在确认边界内执行必要工具；预算不足时输出已完成排查与下一步。";
  }
  if (mode === "implement") {
    return "当前运行模式：implement。可以在确认边界内完成实现；预算不足时输出已完成变更、缺失事项和继续建议。";
  }
  return "当前运行模式：chat。需要工具时遵守权限和确认边界；预算不足时输出已有信息与继续建议。";
}
