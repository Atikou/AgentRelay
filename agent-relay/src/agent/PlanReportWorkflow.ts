import type { ApiResult } from "../orchestrator/Orchestrator.js";
import type { PlanService } from "../plan/PlanService.js";
import { buildPlanAnalysisPrompt, renderUserVisiblePlan } from "../plan/UserPlanRenderer.js";
import type { RunBudget } from "./RunPolicyTypes.js";
import type { LoopChatFn } from "./AgentLoop.js";

export interface PlanReportWorkflowOptions {
  planService: Pick<PlanService, "saveUserVisiblePlan">;
  runAgent: (body: unknown, makeChat?: LoopChatFn) => Promise<ApiResult>;
}

export interface PlanReportWorkflowInput {
  goal: string;
  context?: string;
  sessionId?: string;
  clientName?: string;
  budget?: Partial<RunBudget>;
  makeChat?: LoopChatFn;
}

export class PlanReportWorkflow {
  constructor(private readonly options: PlanReportWorkflowOptions) {}

  async run(input: PlanReportWorkflowInput): Promise<ApiResult> {
    const result = await this.options.runAgent(
      {
        message: buildPlanAnalysisPrompt({ goal: input.goal, context: input.context }),
        mode: "plan",
        sessionId: input.sessionId,
        clientName: input.clientName,
        autoConfirm: false,
        sensitive: true,
        budget: input.budget,
      },
      input.makeChat,
    );
    if (result.status !== 200) return result;

    const body200 = result.body as {
      runId?: string;
      sessionId?: string;
      answer?: string;
      executionMeta?: unknown;
    };
    const userVisiblePlan = this.options.planService.saveUserVisiblePlan(
      renderUserVisiblePlan({
        sourceRunId: body200.runId ?? "unknown-run",
        sessionId: body200.sessionId ?? input.sessionId,
        goal: input.goal,
        markdown: body200.answer ?? "",
      }),
    );
    return {
      status: 200,
      body: {
        userVisiblePlan,
        executionMeta: body200.executionMeta,
        runId: body200.runId,
        warning:
          "UserVisiblePlan is for review only and cannot be executed directly; compile, approve, then execute.",
      },
    };
  }
}
