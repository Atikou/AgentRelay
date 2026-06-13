import {
  buildPendingWorkflowSteps,
  extractCompletedWorkflowSteps,
} from "../orchestrator/runStateTypes.js";
import { BudgetManager, renderBudget } from "./BudgetManager.js";
import { defaultWorkflowPlanner, shouldRunAgentWorkflow } from "./WorkflowPlanner.js";
import type {
  AgentExecutionMeta,
  AgentRunMode,
  LocationExecutionMeta,
  RunBudget,
  RunBudgetKey,
} from "./RunPolicyTypes.js";
import type { AgentToolStep } from "./toolStep.js";
import {
  estimateTaskComplexity,
  resolveSuggestedToolCalls,
  type TaskComplexityTier,
} from "./taskComplexity.js";

export interface FinalizerPartialInput {
  steps: AgentToolStep[];
  budgetExhausted: RunBudgetKey;
  budgetManager: BudgetManager;
  mode: AgentRunMode;
  goal: string;
  location?: LocationExecutionMeta;
}

export interface FinalizerProgress {
  completedSteps: string[];
  missingSteps: string[];
  suggestedBudget: RunBudget;
  suggestedToolCalls: number;
  complexityTier: TaskComplexityTier;
}

export interface FinalizerBudgetMeta {
  suggestedBudget: RunBudget;
  suggestedToolCalls: number;
  complexityTier: TaskComplexityTier;
  completedSteps: string[];
  missingSteps: string[];
}

/** 预算耗尽时的部分收尾与执行元数据补强。 */
export class Finalizer {
  buildPartialAnswer(input: FinalizerPartialInput): string {
    const okSteps = input.steps.filter((s) => s.ok);
    const blockedSteps = input.steps.filter((s) => s.blocked);
    const failedSteps = input.steps.filter((s) => !s.ok && !s.blocked);
    const modified = okSteps.filter((s) => s.permission === "write" || s.permission === "dangerous");
    const progress = this.inferProgress(input);

    const lines = [
      input.budgetManager.formatExhaustedLine(input.budgetExhausted),
      "",
      okSteps.length
        ? `已完成：${okSteps.map((s) => `${s.tool}#${s.iteration}`).join("、")}。`
        : "已完成：尚未成功执行工具调用。",
    ];

    if (blockedSteps.length) {
      lines.push(
        `被阻塞：${blockedSteps.map((s) => `${s.tool}#${s.iteration}（${s.error ?? "权限或确认限制"}）`).join("、")}。`,
      );
    }
    if (failedSteps.length) {
      lines.push(
        `执行失败：${failedSteps.map((s) => `${s.tool}#${s.iteration}（${s.error ?? "未知错误"}）`).join("、")}。`,
      );
    }

    const location = input.location;
    if (location) {
      lines.push(
        location.locatedFiles.length
          ? `已定位文件：${location.locatedFiles.slice(0, 8).join("、")}。`
          : "已定位文件：尚未确认 primary 文件。",
      );
      if (location.candidateFiles.length) {
        lines.push(`候选文件：${location.candidateFiles.slice(0, 8).join("、")}。`);
      }
      if (location.needsContinue) {
        lines.push("定位状态：仍需要继续定位或扩大定位预算。");
      }
    }

    if (progress.missingSteps.length) {
      lines.push(`待继续：${progress.missingSteps.join("、")}。`);
    }

    lines.push(
      "缺失信息：模型尚未输出 final 动作，因此当前结论可能不完整；如需继续，请提高预算或缩小任务范围。",
      `建议工具调用次数（按任务复杂度 ${progress.complexityTier}）：约 ${progress.suggestedToolCalls} 次。`,
      `建议继续预算：${renderBudget(progress.suggestedBudget)}。`,
      modified.length
        ? `本次已执行写入/高风险类工具 ${modified.length} 次，请以 steps 中的工具结果为准核对影响范围。`
        : "本次未执行写入类工具，未修改文件。",
    );

    return lines.join("\n");
  }

  inferProgress(input: FinalizerPartialInput): FinalizerProgress {
    const okSteps = input.steps.filter((s) => s.ok);
    const completedSteps = okSteps.map((s) => `${s.tool}#${s.iteration}`);
    const missingSteps = this.inferMissingSteps(input);
    const budgetMeta = this.buildBudgetMeta(input);
    return {
      completedSteps,
      missingSteps,
      ...budgetMeta,
    };
  }

  buildBudgetExhaustedMeta(input: FinalizerPartialInput): FinalizerBudgetMeta {
    const budgetMeta = this.buildBudgetMeta(input);
    return {
      ...budgetMeta,
      completedSteps: input.steps.filter((s) => s.ok).map((s) => `${s.tool}#${s.iteration}`),
      missingSteps: this.inferMissingSteps(input),
    };
  }

  enrichExecutionMeta(
    base: AgentExecutionMeta,
    input: FinalizerPartialInput,
  ): AgentExecutionMeta {
    if (!base.needsMoreBudget) return base;
    const extra = this.buildBudgetExhaustedMeta(input);
    const suggestedAction = input.location?.needsContinue ? ("continue_locating" as const) : undefined;
    return {
      ...base,
      suggestedBudget: extra.suggestedBudget,
      suggestedToolCalls: extra.suggestedToolCalls,
      complexityTier: extra.complexityTier,
      completedSteps: extra.completedSteps,
      missingSteps: extra.missingSteps,
      suggestedAction,
    };
  }

  private buildBudgetMeta(input: FinalizerPartialInput): Pick<
    FinalizerProgress,
    "suggestedBudget" | "suggestedToolCalls" | "complexityTier"
  > {
    const estimate = estimateTaskComplexity({ goal: input.goal, mode: input.mode });
    const suggested = input.budgetManager.buildSuggestedBudget(input.budgetExhausted);
    const resolved = resolveSuggestedToolCalls({
      goal: input.goal,
      mode: input.mode,
      budgetExhausted: input.budgetExhausted,
      currentBudget: input.budgetManager.budget,
      modeSuggestedToolCalls: input.budgetManager.suggestedBudget.maxToolCalls,
      usedToolCalls: input.steps.length,
    });

    suggested.maxToolCalls = Math.max(suggested.maxToolCalls, resolved.suggestedToolCalls);
    if (input.budgetExhausted === "maxReadCalls") {
      suggested.maxReadCalls = Math.max(suggested.maxReadCalls, estimate.suggestedReadCalls);
    }
    if (input.budgetExhausted === "maxModelTurns") {
      suggested.maxModelTurns = Math.max(suggested.maxModelTurns, estimate.suggestedModelTurns);
    }

    return {
      suggestedBudget: suggested,
      suggestedToolCalls: resolved.suggestedToolCalls,
      complexityTier: resolved.tier,
    };
  }

  private inferMissingSteps(input: FinalizerPartialInput): string[] {
    const missing: string[] = [];
    if (shouldRunAgentWorkflow(input.goal, input.mode)) {
      const workflow = defaultWorkflowPlanner.plan(input.goal, input.mode);
      if (workflow) {
        const completed = extractCompletedWorkflowSteps(input.steps, workflow.steps);
        missing.push(...buildPendingWorkflowSteps(completed, workflow.steps));
      }
    }
    if (input.location?.needsContinue) {
      missing.push("continue_location");
    }
    missing.push("model_final_answer");
    return missing;
  }
}

export const defaultFinalizer = new Finalizer();
