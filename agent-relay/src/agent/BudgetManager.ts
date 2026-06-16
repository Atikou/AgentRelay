import type { ToolPermission } from "../core/permissions.js";
import type { AgentToolStep } from "./toolStep.js";
import type { RunBudget, RunBudgetKey, RunBudgetUsage } from "./RunPolicyTypes.js";

export interface BudgetCheckInput {
  toolPermission?: ToolPermission;
  permissionAllowed: boolean;
  steps: AgentToolStep[];
  modelTurns: number;
}

/** 分项运行预算：统计用量、检测耗尽、生成建议预算。 */
export class BudgetManager {
  private runStartedAt = 0;

  constructor(
    readonly budget: RunBudget,
    readonly suggestedBudget: RunBudget,
  ) {}

  markRunStarted(at = Date.now()): void {
    this.runStartedAt = at;
  }

  buildUsage(steps: AgentToolStep[], modelTurns: number): RunBudgetUsage {
    const permissionUsage = countSuccessfulPermissionUsage(steps);
    return {
      modelTurns,
      toolCalls: steps.length,
      readCalls: permissionUsage.readCalls,
      writeCalls: permissionUsage.writeCalls,
      shellCalls: permissionUsage.shellCalls,
      runtimeMs: Math.max(0, Date.now() - this.runStartedAt),
    };
  }

  findRuntimeExhaustion(): RunBudgetKey | undefined {
    if (Date.now() - this.runStartedAt >= this.budget.maxRuntimeMs) return "maxRuntimeMs";
    return undefined;
  }

  findModelTurnExhaustion(modelTurns: number): RunBudgetKey | undefined {
    if (modelTurns >= this.budget.maxModelTurns) return "maxModelTurns";
    return undefined;
  }

  findToolExhaustion(input: {
    toolPermission?: ToolPermission;
    permissionAllowed: boolean;
    steps: AgentToolStep[];
  }): RunBudgetKey | undefined {
    if (input.steps.length >= this.budget.maxToolCalls) return "maxToolCalls";
    if (!input.toolPermission || !input.permissionAllowed) return undefined;

    const usage = countSuccessfulPermissionUsage(input.steps);
    if (input.toolPermission === "read" && usage.readCalls >= this.budget.maxReadCalls) {
      return "maxReadCalls";
    }
    if (
      (input.toolPermission === "write" || input.toolPermission === "dangerous") &&
      usage.writeCalls >= this.budget.maxWriteCalls
    ) {
      return "maxWriteCalls";
    }
    if (input.toolPermission === "shell" && usage.shellCalls >= this.budget.maxShellCalls) {
      return "maxShellCalls";
    }
    return undefined;
  }

  findAnyExhaustion(input: BudgetCheckInput): RunBudgetKey | undefined {
    return (
      this.findRuntimeExhaustion() ??
      this.findModelTurnExhaustion(input.modelTurns) ??
      this.findToolExhaustion(input)
    );
  }

  buildSuggestedBudget(exhausted?: RunBudgetKey): RunBudget {
    const suggested = { ...this.suggestedBudget };
    if (exhausted) {
      suggested[exhausted] = Math.max(suggested[exhausted], this.budget[exhausted] * 2);
    }
    return suggested;
  }

  /** PlanWorkflow 可新增步骤上限（按 tool/read 分项）。 */
  remainingWorkflowSteps(steps: AgentToolStep[], pendingWorkflowTools: number): number {
    const usage = countSuccessfulPermissionUsage(steps);
    return Math.min(
      pendingWorkflowTools,
      Math.max(0, this.budget.maxToolCalls - steps.length),
      Math.max(0, this.budget.maxReadCalls - usage.readCalls),
    );
  }

  formatExhaustedLine(budgetExhausted: RunBudgetKey): string {
    return `已达到当前运行预算（${budgetExhausted}=${this.budget[budgetExhausted]}），我已停止继续调用模型或工具，并基于已有信息做部分收尾。`;
  }
}

export function countSuccessfulPermissionUsage(steps: AgentToolStep[]): Pick<
  RunBudgetUsage,
  "readCalls" | "writeCalls" | "shellCalls"
> {
  const successful = steps.filter((s) => s.ok);
  return {
    readCalls: successful.filter((s) => s.permission === "read").length,
    writeCalls: successful.filter((s) => s.permission === "write" || s.permission === "dangerous").length,
    shellCalls: successful.filter((s) => s.permission === "shell").length,
  };
}

export function renderBudget(budget: RunBudget): string {
  return [
    `maxModelTurns=${budget.maxModelTurns}`,
    `maxToolCalls=${budget.maxToolCalls}`,
    `maxReadCalls=${budget.maxReadCalls}`,
    `maxWriteCalls=${budget.maxWriteCalls}`,
    `maxShellCalls=${budget.maxShellCalls}`,
    `maxRuntimeMs=${budget.maxRuntimeMs}`,
  ].join(", ");
}
