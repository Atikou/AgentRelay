import type { ApiResult } from "../orchestrator/Orchestrator.js";
import type { PlanService } from "../plan/PlanService.js";

export interface PlanCompileWorkflowOptions {
  planService: Pick<PlanService, "compileUserVisiblePlan">;
}

export interface PlanCompileWorkflowInput {
  userVisiblePlanId: string;
  confirmedTodoIds: string[];
  sessionId?: string;
}

/**
 * Workflow-level entry for turning confirmed user-visible todos into an
 * InternalTaskPlan draft. The draft is still awaiting approval and cannot run
 * until the normal approve -> execute chain is used.
 */
export class PlanCompileWorkflow {
  constructor(private readonly options: PlanCompileWorkflowOptions) {}

  run(input: PlanCompileWorkflowInput): ApiResult {
    const draft = this.options.planService.compileUserVisiblePlan({
      userVisiblePlanId: input.userVisiblePlanId,
      confirmedTodoIds: input.confirmedTodoIds,
      sessionId: input.sessionId,
    });
    return {
      status: 200,
      body: {
        planId: draft.planId,
        version: draft.version,
        status: draft.status,
        planHash: draft.planHash,
        previewMarkdown: draft.previewMarkdown,
        publicPlanJson: draft.publicPlanJson,
        sourceUserVisiblePlanId: draft.sourceUserVisiblePlan.id,
        warning:
          "Compiled result is an awaiting-approval InternalTaskPlan draft; approve before execute.",
      },
    };
  }
}
