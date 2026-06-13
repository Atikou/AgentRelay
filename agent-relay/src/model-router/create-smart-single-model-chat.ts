import type { LoopChatFn } from "../agent/AgentLoop.js";
import type { RouteOptions } from "../model/ModelRouter.js";
import type { ModelTaskType } from "../model/taskType.js";
import type { ChatRequest, ModelResponse } from "../model/types.js";
import type { ModelChatFn } from "../model-orchestrator/types.js";
import { buildRouterInputFromChat } from "./router-input.js";
import { resolveRuleOnlyAnswer } from "./rule-only-responses.js";
import { estimateRouterContextTokens } from "./router-context-estimate.js";
import type { SmartModelRouter } from "./smart-model-router.js";
import { RouterError, type RouterInput } from "./types.js";

export type SmartSingleModelChatFn = (
  request: ChatRequest,
  opts?: { sensitive?: boolean; taskType?: ModelTaskType },
) => Promise<ModelResponse>;

/** 取最近一条 user 消息作为路由输入。 */
export function extractLastUserMessage(
  messages: { role: string; content: string }[],
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === "user") return msg.content.trim();
  }
  return "";
}

/** Agent 循环路由：尊重 taskType / sensitive，强制单模型（每轮 ReAct 不走协作流水线）。 */
export function buildAgentRouterInput(
  userInput: string,
  opts?: {
    sensitive?: boolean;
    taskType?: ModelTaskType;
    messages?: ReadonlyArray<{ role: string; content: string }>;
  },
): RouterInput {
  const messages = opts?.messages ?? [];
  return buildRouterInputFromChat({
    message: userInput,
    sensitive: opts?.sensitive,
    taskType: opts?.taskType,
    forceSingleModel: true,
    allowCollaboration: false,
    contextTokenEstimate: messages.length > 0 ? estimateRouterContextTokens(messages) : undefined,
    recentMessagesCount: messages.length > 0 ? messages.length : undefined,
    mayUseTools: true,
  });
}

/** 经 SmartModelRouter + ModelRegistry 选模型并调用（单模型，写 model_call_logs）。 */
export function createSmartSingleModelChatFn(deps: {
  smartRouter: SmartModelRouter;
  modelChatFn: ModelChatFn;
  buildInput: (
    userInput: string,
    opts?: { sensitive?: boolean; taskType?: ModelTaskType },
    context?: { messages?: ReadonlyArray<{ role: string; content: string }> },
  ) => RouterInput;
}): SmartSingleModelChatFn {
  return async (request, opts) => {
    const userInput = extractLastUserMessage(request.messages);
    let decision;
    try {
      decision = deps.smartRouter.route(
        deps.buildInput(userInput, opts, { messages: request.messages }),
      );
    } catch (error) {
      if (error instanceof RouterError) {
        throw new Error(error.message);
      }
      throw error;
    }

    const modelId = decision.selectedModelId;
    if (decision.executionStrategy === "rule_only") {
      const content = resolveRuleOnlyAnswer(decision.taskType, userInput);
      return {
        content,
        toolCalls: [],
        clientName: "rule-only",
        modelName: "rule-only",
        location: "local",
        latencyMs: 0,
      };
    }
    if (!modelId) {
      throw new Error("路由未选出可用模型");
    }

    const { response } = await deps.modelChatFn(modelId, request, {
      routeLogId: decision.id,
      role: "primary",
      sessionId: decision.sessionId,
    });
    return response;
  };
}

/** AgentLoop 默认 chat：Smart 单模型路由。 */
export function createAgentChatFn(deps: {
  smartRouter: SmartModelRouter;
  modelChatFn: ModelChatFn;
}): LoopChatFn {
  return createSmartSingleModelChatFn({
    ...deps,
    buildInput: (userInput, opts, context) =>
      buildAgentRouterInput(userInput, {
        sensitive: opts?.sensitive,
        taskType: opts?.taskType,
        messages: context?.messages,
      }),
  });
}
