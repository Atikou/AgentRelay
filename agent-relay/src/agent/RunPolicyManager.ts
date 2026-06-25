import { resolveAllowedPermissions } from "./WorkflowCapability.js";
import { BudgetManager } from "./BudgetManager.js";
import { defaultWorkflowRouter } from "./WorkflowRouter.js";
import { defaultEntryIntentRouter } from "./routing/EntryIntentRouter.js";
import {
  afterPlanForVariant,
  detectPlanExecutionVariant,
  type PlanExecutionVariant,
} from "./planExecutionVariant.js";
import type { AgentIntentType } from "./IntentTypes.js";
import {
  MODE_BASE_BUDGETS,
  MODE_SUGGESTED_BUDGETS,
  mergeBudgetMax,
  mergeRunBudget,
} from "./runBudgetDefaults.js";
import {
  parseRunModeValue,
  parseUserPermissionPolicyValue,
  type AgentExecutionStage,
  type AgentRunMode,
  type ResolveRunPolicyInput,
  type RunBudget,
  type RunPolicy,
  type UserPermissionPolicy,
} from "./RunPolicyTypes.js";

/** 解析运行模式、分项预算与权限策略；与 `BudgetManager` 配对使用。 */
export class RunPolicyManager {
  resolve(input: ResolveRunPolicyInput = {}): RunPolicy {
    return this.buildPolicy(input, defaultEntryIntentRouter.resolve({
      requestedMode: input.requestedMode,
      forceRequestedMode: input.forceMode === true,
      message: input.message,
      taskType: input.taskType,
      sessionId: input.sessionId,
    }));
  }

  async resolveAsync(input: ResolveRunPolicyInput = {}): Promise<RunPolicy> {
    const decision = await defaultEntryIntentRouter.resolveAsync({
      requestedMode: input.requestedMode,
      forceRequestedMode: input.forceMode === true,
      message: input.message,
      taskType: input.taskType,
      sessionId: input.sessionId,
    });
    return this.buildPolicy(input, decision);
  }

  private buildPolicy(input: ResolveRunPolicyInput, decision: import("./routing/IntentDecision.js").IntentDecision): RunPolicy {
    const mode = decision.mode;
    const budget = this.resolveBudget(mode, input.budget);
    const suggestedBudget = mergeBudgetMax(MODE_SUGGESTED_BUDGETS[mode], budget);
    const explicitPermissionPolicy = parseUserPermissionPolicyValue(input.requestedPermissionPolicy);
    const permissionPolicy = explicitPermissionPolicy ?? inferPermissionPolicy({
      mode,
      intent: decision.intent,
      autoConfirm: input.autoConfirm === true,
    });
    const workflowRoute = defaultWorkflowRouter.routeIntent(decision.intent);
    const allowedPermissions = resolveAllowedPermissions(workflowRoute, permissionPolicy);

    const planVariant = resolvePlanVariant(decision.intent, input.message);
    const afterPlan = afterPlanForVariant(planVariant);

    return {
      mode,
      executionStage: stageForIntent(decision.intent),
      modeSource: decision.modeSource,
      intent: decision.intent,
      workflowType: decision.workflowType,
      permissionPolicy,
      permissionPolicySource: explicitPermissionPolicy ? "explicit" : "inferred",
      planVariant,
      afterPlan,
      budget,
      allowedPermissions,
      requireFinalAnswer: true,
      allowPartialAnswer: true,
      suggestedBudget,
      systemHint: buildSystemHint(mode),
      intentDecisionSource: decision.source,
      isContinuation: decision.isContinuation,
      intentDecisionReason: decision.reason,
      intentDecisionConfidence: decision.confidence,
      inheritedTaskId: decision.inheritedTaskId,
      previousWorkflowType: decision.previousWorkflowType,
      continuationScore: decision.continuationScore,
      continuationSignals: decision.continuationSignals,
    };
  }

  parseMode(mode: string | undefined): AgentRunMode | undefined {
    return parseRunModeValue(mode);
  }

  parsePermissionPolicy(policy: string | undefined): UserPermissionPolicy | undefined {
    return parseUserPermissionPolicyValue(policy);
  }

  inferMode(input: ResolveRunPolicyInput): AgentRunMode {
    return defaultEntryIntentRouter.resolve({
      message: input.message,
      taskType: input.taskType,
      sessionId: input.sessionId,
      requestedMode: input.requestedMode,
      forceRequestedMode: input.forceMode === true,
    }).mode;
  }

  resolveBudget(mode: AgentRunMode, override: Partial<RunBudget> | undefined): RunBudget {
    return mergeRunBudget(MODE_BASE_BUDGETS[mode], override);
  }

  createBudgetManager(policy: RunPolicy): BudgetManager {
    return new BudgetManager(policy.budget, policy.suggestedBudget);
  }
}

export const defaultRunPolicyManager = new RunPolicyManager();

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
      "可将可并行、上下文独立的子步骤委派给 dispatch_subagent（tasks: DelegatedTask[]）；子 Agent 在独立上下文中执行，只回收结构化结果。",
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

function stageForIntent(intent: AgentIntentType): AgentExecutionStage {
  if (intent === "plan") return "plan";
  if (intent === "verify" || intent === "run" || intent === "debug") return "verify";
  if (intent === "edit" || intent === "refactor" || intent === "generate_file") return "execute";
  return "analyze";
}

function resolvePlanVariant(
  intent: AgentIntentType,
  message?: string,
): PlanExecutionVariant | undefined {
  if (intent !== "plan") return undefined;
  return detectPlanExecutionVariant(message) ?? "plan_only";
}
