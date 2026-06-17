import type { Planner } from "../agent/Planner.js";
import type { ApiResult } from "../orchestrator/Orchestrator.js";
import { canAutoApprovePlan } from "./planActivationPolicy.js";
import {
  PlanActivationWorkflow,
  type PlanActivationInput,
  type PlanExecutionMode,
} from "./PlanActivationWorkflow.js";
import type { PlanService } from "./PlanService.js";

export type { PlanExecutionMode };

export interface PlanRuntimeOptions {
  planService: PlanService;
  executeStoredPlan: (
    planId: string,
    version: number,
    payload: Record<string, unknown>,
    dryRun: boolean,
  ) => Promise<ApiResult>;
  planner?: Planner;
}

export interface PlanDraftActivateInput {
  goal: string;
  context?: string;
  sessionId?: string;
  dryRun?: boolean;
  autoApprove?: boolean;
  autoConfirm?: boolean;
  executionMode?: PlanExecutionMode;
  planner?: Planner;
}

/**
 * 统一计划运行时：analyze / draft / compile / activate 共用 compile→approve→execute 语义。
 */
export class PlanRuntime {
  private readonly activation: PlanActivationWorkflow;

  constructor(private readonly options: PlanRuntimeOptions) {
    this.activation = new PlanActivationWorkflow({
      planService: options.planService,
      executeStoredPlan: options.executeStoredPlan,
      planner: options.planner,
    });
  }

  activateFromUserVisiblePlan(input: PlanActivationInput): Promise<ApiResult> {
    return this.activation.activate(input);
  }

  /** Draft Planner 路径：生成 InternalTaskPlan 草案后走与 activate 相同的审批/执行链。 */
  async activateFromDraft(input: PlanDraftActivateInput): Promise<ApiResult> {
    const planner = input.planner ?? this.options.planner;
    if (!planner) {
      return { status: 500, body: { error: "Planner 未配置" } };
    }

    const draft = await this.options.planService.createDraftFromPlanner({
      goal: input.goal,
      context: input.context,
      sessionId: input.sessionId,
      planner,
    });

    const record = this.options.planService.getRecord(draft.planId, draft.version);
    if (!record) {
      return { status: 500, body: { error: "草案未找到" } };
    }

    const dryRun = input.dryRun ?? false;
    const executionMode: PlanExecutionMode = input.executionMode ?? "agent_loop";
    const autoApproved = canAutoApprovePlan({
      dryRun,
      autoApprove: input.autoApprove,
      internal: record.internal,
    });

    if (!autoApproved) {
      return {
        status: 200,
        body: {
          phase: "compiled",
          planId: draft.planId,
          version: draft.version,
          status: draft.status,
          executionMode,
          dryRun,
          autoApproved: false,
          previewMarkdown: draft.previewMarkdown,
          publicPlanJson: draft.publicPlanJson,
          warning: "草案已生成（awaiting_approval）；含副作用步骤须 approve 后再 execute",
          nextAction: {
            approve: `POST /api/plans/${draft.planId}/approve`,
            execute: `POST /api/plans/${draft.planId}/execute`,
          },
        },
      };
    }

    this.options.planService.approve(
      draft.planId,
      draft.version,
      dryRun ? "system:dry-run" : "system:draft-activate",
      dryRun ? "auto before dry-run draft activate" : "draft-activate",
    );

    const execution = await this.options.executeStoredPlan(
      draft.planId,
      draft.version,
      {
        autoConfirm: input.autoConfirm ?? dryRun,
        sessionId: input.sessionId,
        executionMode,
        fallbackToPlanOnUncertainty: true,
      },
      dryRun,
    );

    if (execution.status !== 200) {
      return execution;
    }

    return {
      status: 200,
      body: {
        phase: "executed",
        planId: draft.planId,
        version: draft.version,
        status: dryRun ? "dry_run_completed" : "executed",
        executionMode,
        dryRun,
        autoApproved: true,
        execution: execution.body,
      },
    };
  }
}
