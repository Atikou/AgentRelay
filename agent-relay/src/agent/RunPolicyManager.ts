import { type ToolPermission } from "./permissions.js";
import { BudgetManager } from "./BudgetManager.js";
import { defaultIntentRouter } from "./IntentRouter.js";
import {
  parseRunModeValue,
  parseUserPermissionPolicyValue,
  type AgentRunMode,
  type ResolveRunPolicyInput,
  type RunBudget,
  type RunPolicy,
  type UserPermissionPolicy,
} from "./RunPolicyTypes.js";

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

/** 解析运行模式、分项预算与权限策略；与 `BudgetManager` 配对使用。 */
export class RunPolicyManager {
  resolve(input: ResolveRunPolicyInput = {}): RunPolicy {
    const route = defaultIntentRouter.route({
      requestedMode: input.requestedMode,
      message: input.message,
      taskType: input.taskType,
    });
    const mode = route.mode;
    const budget = this.resolveBudget(mode, input.budget);
    const suggestedBudget = mergeBudgetMax(MODE_SUGGESTED_BUDGETS[mode], budget);
    const explicitPermissionPolicy = parseUserPermissionPolicyValue(input.requestedPermissionPolicy);
    const permissionPolicy = explicitPermissionPolicy ?? inferPermissionPolicy({
      mode,
      intent: route.intent,
      autoConfirm: input.autoConfirm === true,
    });

    return {
      mode,
      modeSource: route.modeSource,
      intent: route.intent,
      workflowType: route.workflowType,
      permissionPolicy,
      permissionPolicySource: explicitPermissionPolicy ? "explicit" : "inferred",
      budget,
      allowedPermissions: permissionsForPolicy(permissionPolicy),
      requireFinalAnswer: true,
      allowPartialAnswer: true,
      suggestedBudget,
      systemHint: buildSystemHint(mode),
    };
  }

  parseMode(mode: string | undefined): AgentRunMode | undefined {
    return parseRunModeValue(mode);
  }

  parsePermissionPolicy(policy: string | undefined): UserPermissionPolicy | undefined {
    return parseUserPermissionPolicyValue(policy);
  }

  inferMode(input: ResolveRunPolicyInput): AgentRunMode {
    return defaultIntentRouter.inferMode(input);
  }

  resolveBudget(mode: AgentRunMode, override: Partial<RunBudget> | undefined): RunBudget {
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

  createBudgetManager(policy: RunPolicy): BudgetManager {
    return new BudgetManager(policy.budget, policy.suggestedBudget);
  }
}

export const defaultRunPolicyManager = new RunPolicyManager();

function normalizeBudgetValue(value: number | undefined, max: number): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  if (n <= 0) return undefined;
  return Math.min(n, max);
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

function inferPermissionPolicy(input: {
  mode: AgentRunMode;
  intent: string;
  autoConfirm: boolean;
}): UserPermissionPolicy {
  if (
    input.mode === "plan" ||
    input.mode === "review" ||
    input.intent === "answer" ||
    input.intent === "plan" ||
    input.intent === "review" ||
    input.intent === "summarize" ||
    input.intent === "search"
  ) {
    return "readOnly";
  }
  if (input.intent === "run" || input.intent === "verify" || input.intent === "debug") {
    return input.autoConfirm ? "autoRun" : "confirmBeforeRun";
  }
  return input.autoConfirm ? "autoEdit" : "confirmBeforeEdit";
}

function permissionsForPolicy(policy: UserPermissionPolicy): ToolPermission[] {
  switch (policy) {
    case "readOnly":
      return ["read"];
    case "confirmBeforeEdit":
    case "autoEdit":
      return ["read", "write"];
    case "confirmBeforeRun":
    case "autoRun":
      return ["read", "write", "shell", "network", "dangerous"];
  }
}
