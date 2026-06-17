import type { Planner } from "../agent/Planner.js";
import type { ApiResult } from "../orchestrator/Orchestrator.js";
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

/**
 * 统一计划运行时：analyze / compile / activate 共用 compile→approve→execute 语义。
 */
export class PlanRuntime {
  private readonly activation: PlanActivationWorkflow;

  constructor(options: PlanRuntimeOptions) {
    this.activation = new PlanActivationWorkflow({
      planService: options.planService,
      executeStoredPlan: options.executeStoredPlan,
      planner: options.planner,
    });
  }

  activateFromUserVisiblePlan(input: PlanActivationInput): Promise<ApiResult> {
    return this.activation.activate(input);
  }
}
