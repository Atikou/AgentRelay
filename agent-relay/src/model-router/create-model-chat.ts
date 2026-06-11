import { performance } from "node:perf_hooks";

import type { ModelClient } from "../model/types.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { ModelChatFn } from "../model-orchestrator/types.js";
import type { ModelCallLogStore } from "./route-stores.js";

function preview(text: string, max = 400): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function createModelChatFn(
  clientMap: Map<string, ModelClient>,
  callLogStore: ModelCallLogStore,
  trace?: TraceLogger,
): ModelChatFn {
  return async (modelId, request, meta) => {
    const client = clientMap.get(modelId);
    if (!client) throw new Error(`未找到模型：${modelId}`);
    const start = performance.now();
    const inputPreview = preview(
      request.messages
        .slice(-2)
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n"),
    );
    try {
      const response = await client.chat(request);
      const durationMs = Math.round(response.latencyMs || performance.now() - start);
      const callLogId = callLogStore.create({
        routeLogId: meta.routeLogId,
        collaborationRunId: meta.collaborationRunId,
        sessionId: meta.sessionId,
        modelId,
        role: meta.role,
        inputPreview,
        outputPreview: preview(response.content),
        status: "ok",
        promptTokens: response.usage?.inputTokens,
        completionTokens: response.usage?.outputTokens,
        durationMs,
      });
      trace?.write({
        type: "model_call",
        success: true,
        client: response.clientName,
        model: response.modelName,
        location: response.location,
        latencyMs: durationMs,
        role: meta.role,
        routeLogId: meta.routeLogId,
        collaborationRunId: meta.collaborationRunId,
      });
      return { response, callLogId };
    } catch (error) {
      const durationMs = Math.round(performance.now() - start);
      const callLogId = callLogStore.create({
        routeLogId: meta.routeLogId,
        collaborationRunId: meta.collaborationRunId,
        sessionId: meta.sessionId,
        modelId,
        role: meta.role,
        inputPreview,
        status: "error",
        errorMessage: String(error),
        durationMs,
      });
      trace?.write({
        type: "model_call",
        success: false,
        client: modelId,
        model: client.model,
        location: client.location,
        latencyMs: durationMs,
        role: meta.role,
        routeLogId: meta.routeLogId,
        error: String(error),
      });
      throw error;
    }
  };
}
