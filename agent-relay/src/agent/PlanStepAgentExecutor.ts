import type { ApiResult } from "../orchestrator/Orchestrator.js";
import { StepExecutionError, type StepContext, type StepExecutor, type StepResult } from "./TaskRunner.js";
import type { PlanStep } from "./types.js";
import type { RunBudget } from "./RunPolicyTypes.js";

export type AgentLoopRunFn = (body: unknown) => Promise<ApiResult>;

export interface PlanStepAgentExecutorOptions {
  runAgent: AgentLoopRunFn;
  sessionId?: string;
  parentRunId?: string;
  planGoal?: string;
  autoConfirm?: boolean;
  stepBudget?: Partial<RunBudget>;
}

/**
 * 将计划单步委派给 Agent 主循环（ReAct），用于 agent_loop 执行模式。
 */
export class PlanStepAgentExecutor implements StepExecutor {
  constructor(private readonly options: PlanStepAgentExecutorOptions) {}

  async execute(step: PlanStep, _ctx: StepContext): Promise<StepResult> {
    const message = [
      `请完成计划中的子任务（须产生真实副作用，若只读请明确说明）：`,
      `计划目标：${this.options.planGoal ?? step.title}`,
      `步骤 ID：${step.id}`,
      `标题：${step.title}`,
      step.objective ? `目标：${step.objective}` : "",
      step.description ? `说明：${step.description}` : "",
      step.acceptance ? `验收：${step.acceptance}` : "",
      step.tool ? `建议首选工具：${step.tool}` : "",
      step.requiredContext?.length ? `相关上下文：${step.requiredContext.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const budget = {
      maxModelTurns: 10,
      maxToolCalls: 16,
      maxReadCalls: 12,
      maxWriteCalls: 4,
      maxShellCalls: 2,
      ...this.options.stepBudget,
    };

    const result = await this.options.runAgent({
      message,
      mode: "implement",
      sessionId: this.options.sessionId,
      autoConfirm: this.options.autoConfirm ?? false,
      budget,
      parentRunId: this.options.parentRunId,
      taskType: "code",
    });

    if (result.status !== 200) {
      const body = result.body as { error?: string };
      throw new StepExecutionError(
        body.error ?? `Agent 子运行失败（HTTP ${result.status}）`,
      );
    }

    const body = result.body as {
      answer?: string;
      runId?: string;
      executionMeta?: { workflowDiffs?: unknown[]; toolCalls?: number };
    };
    const diffHint =
      Array.isArray(body.executionMeta?.workflowDiffs) && body.executionMeta.workflowDiffs.length > 0
        ? `\n[workflowDiffs=${body.executionMeta.workflowDiffs.length}]`
        : "";
    const output = `${body.answer ?? "(无最终回答)"}${diffHint}`.trim();
    return { output, toolCallId: body.runId ? `agent:${body.runId}` : undefined };
  }
}
