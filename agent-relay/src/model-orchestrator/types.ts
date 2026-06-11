import type { DraftReviewResult, ExecutionStrategy, RouterDecision } from "../model-router/types.js";
import type { ChatRequest, ModelResponse } from "../model/types.js";
import type { ModelRole } from "../model-router/types.js";

export interface RenderedPrompt {
  systemSectionsText: string;
  finalMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

export interface OrchestratorInput {
  routerDecision: RouterDecision;
  renderedPrompt: RenderedPrompt;
  userInput: string;
  sessionId?: string;
  temperature?: number;
}

export interface OrchestratorResult {
  finalAnswer: string;
  usedStrategy: ExecutionStrategy;
  usedModelIds: string[];
  collaborationRunId?: string;
  modelCallIds: string[];
  reviewResult?: DraftReviewResult;
  clientName?: string;
  modelName?: string;
  location?: string;
  latencyMs?: number;
  usage?: ModelResponse["usage"];
}

export interface ModelChatResult {
  response: ModelResponse;
  callLogId: string;
}

export type ModelChatFn = (
  modelId: string,
  request: ChatRequest,
  meta: {
    role: ModelRole;
    routeLogId: string;
    collaborationRunId?: string;
    sessionId?: string;
  },
) => Promise<ModelChatResult>;

export type { DraftReviewResult };
