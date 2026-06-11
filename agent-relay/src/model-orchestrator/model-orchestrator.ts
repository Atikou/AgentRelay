import type { CollaborationRunStore } from "../model-router/route-stores.js";
import { runDraftReviewPipeline } from "./pipelines/draft-review-pipeline.js";
import { runSingleModelPipeline } from "./pipelines/single-model-pipeline.js";
import type { ModelChatFn, OrchestratorInput, OrchestratorResult } from "./types.js";

export class ModelOrchestrator {
  constructor(
    private readonly chat: ModelChatFn,
    private readonly collaborationStore: CollaborationRunStore,
  ) {}

  async run(input: OrchestratorInput): Promise<OrchestratorResult> {
    const strategy = input.routerDecision.executionStrategy;
    if (strategy === "single_model") {
      return runSingleModelPipeline(input, this.chat);
    }
    if (strategy === "local_draft_remote_review") {
      return runDraftReviewPipeline(
        input,
        this.chat,
        this.collaborationStore,
        input.routerDecision.risk,
      );
    }
    throw new Error(`不支持的执行策略：${strategy}`);
  }
}
