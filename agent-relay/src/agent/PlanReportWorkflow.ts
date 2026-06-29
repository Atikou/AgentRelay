import type { ApiResult } from "../orchestrator/Orchestrator.js";
import type { PlanService } from "../plan/PlanService.js";
import { resolvePlanReportMarkdown, countSuccessfulReadSteps } from "../plan/planReportEnrichment.js";
import { buildPlanAnalysisPrompt, renderUserVisiblePlan } from "../plan/UserPlanRenderer.js";
import type { AgentToolStep } from "./toolStep.js";
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
        forceMode: true,
        sessionId: input.sessionId,
        clientName: input.clientName,
        autoConfirm: false,
        sensitive: true,
        skipPlanHandoff: true,
        budget: input.budget,
      },
      input.makeChat,
    );
    if (result.status !== 200) return result;

    const body200 = result.body as {
      runId?: string;
      sessionId?: string;
      answer?: string;
      steps?: AgentToolStep[];
      planHandoff?: { planMarkdown?: string };
      executionMeta?: unknown;
      awaitingPlanHandoff?: boolean;
    };

    const resolved = resolvePlanReportMarkdown({
      goal: input.goal,
      modelAnswer: body200.answer,
      planHandoffMarkdown: body200.planHandoff?.planMarkdown,
      steps: body200.steps,
    });

    if (!resolved.quality.acceptable) {
      return {
        status: 422,
        body: {
          error:
            "计划报告质量不足：模型未输出有效 Markdown 计划，且无法从只读扫描结果补全。请换用更强模型、缩小分析范围，或确认工作区可读。",
          code: "PLAN_REPORT_QUALITY_LOW",
          quality: resolved.quality,
          runId: body200.runId,
          sessionId: body200.sessionId,
          readToolSteps: countSuccessfulReadSteps(body200.steps ?? []),
          hint: "可在智能体模式用流式执行观察工具调用与模型轮次。",
        },
      };
    }

    const userVisiblePlan = this.options.planService.saveUserVisiblePlan(
      renderUserVisiblePlan({
        sourceRunId: body200.runId ?? "unknown-run",
        sessionId: body200.sessionId ?? input.sessionId,
        goal: input.goal,
        markdown: resolved.markdown,
      }),
    );
    return {
      status: 200,
      body: {
        userVisiblePlan,
        executionMeta: body200.executionMeta,
        runId: body200.runId,
        reportQuality: resolved.quality,
        reportEnriched: resolved.enriched,
        warning: resolved.enriched
          ? "模型原始回答过短，报告已由只读扫描结果自动补全；编译前请人工审阅 Todo。"
          : "UserVisiblePlan is for review only and cannot be executed directly; compile, approve, then execute.",
      },
    };
  }
}
