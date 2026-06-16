import type { ContextManager } from "../context/ContextManager.js";
import type { CorrelationContext } from "../core/correlation.js";
import type { ModelOrchestrator } from "../model-orchestrator/index.js";
import type { ModelRouter } from "../model/ModelRouter.js";
import { buildRouterInputFromChat } from "../model-router/router-input.js";
import {
  applyPromptStrategyToSystemText,
  defaultPromptStrategyBuilder,
} from "../model-router/prompt-strategy-builder.js";
import { estimateRouterContextTokens } from "../model-router/router-context-estimate.js";
import type { SmartModelRouter } from "../model-router/smart-model-router.js";
import { RouterError } from "../model-router/types.js";
import { parseModelTaskTypeOrError, type ModelTaskType } from "../model/taskType.js";
import type { TraceLogger } from "../trace/TraceLogger.js";

import { AgentRunRegistry, isRunCancelledError } from "./AgentRunRegistry.js";
import type { ChatStreamEvent } from "./ChatStream.js";
import type { ApiResult } from "./Orchestrator.js";
import type { RunStore } from "./RunStore.js";

export interface ChatServiceDeps {
  runs: RunStore;
  contextManager: ContextManager;
  modelRouter: ModelRouter;
  smartModelRouter?: SmartModelRouter;
  modelOrchestrator?: ModelOrchestrator;
  agentRunRegistry: AgentRunRegistry;
  trace?: TraceLogger;
}

/**
 * 单次对话（非 Agent）的编排：从 Orchestrator 抽出，负责 `POST /api/chat` 与
 * `POST /api/chat/stream` 的智能路由 / 草拟-审查协作 / 流式 token 逻辑。
 * Orchestrator 只保留 Agent / Task / Plan 编排并委派到此处。
 */
export class ChatService {
  constructor(private readonly deps: ChatServiceDeps) {}

  private ensureSession(sessionId: string | undefined, title: string): string {
    if (sessionId && this.deps.contextManager.getSession(sessionId)) return sessionId;
    return this.deps.contextManager.createSession(title).id;
  }

  private correlationFor(runId: string, extra: Omit<CorrelationContext, "runId">): CorrelationContext {
    return { runId, ...extra };
  }

  async runChat(body: unknown): Promise<ApiResult> {
    const payload = (body ?? {}) as {
      clientName?: string;
      message?: string;
      system?: string;
      sensitive?: boolean;
      taskType?: string;
      qualityMode?: "fast" | "balanced" | "deep";
      allowCollaboration?: boolean;
      forceSingleModel?: boolean;
      hasAttachments?: boolean;
      attachmentTypes?: Array<"image" | "pdf" | "doc" | "code" | "audio" | "unknown">;
      sessionId?: string;
      maxCostUsd?: number;
      spentCostUsd?: number;
      persist?: boolean;
    };

    const message = (payload.message ?? "").trim();
    if (!message) return { status: 400, body: { error: "message 不能为空" } };

    const taskTypeParsed = parseModelTaskTypeOrError(payload.taskType);
    if (!taskTypeParsed.ok) return { status: 400, body: { error: taskTypeParsed.error } };

    const forceClient =
      payload.clientName && payload.clientName !== "__default__" ? payload.clientName : undefined;

    const persist = payload.persist !== false;
    const sessionId = persist ? this.ensureSession(payload.sessionId, "网页对话") : undefined;
    const requestId = crypto.randomUUID();

    const run = this.deps.runs.create({
      kind: "chat",
      status: "running",
      sessionId,
      goal: message.slice(0, 200),
      correlation: { runId: "", sessionId, requestId },
    });
    const correlation = this.correlationFor(run.id, { sessionId, requestId });
    this.deps.runs.update(run.id, { correlationJson: JSON.stringify(correlation) });

    const systemBase = payload.system?.trim() ?? "";
    if (persist && sessionId) {
      this.deps.contextManager.saveUserMessage(sessionId, message);
    }

    const messages =
      persist && sessionId
        ? this.deps.contextManager.buildChatMessages(
            await this.deps.contextManager.restoreContextPackage(sessionId, message),
            systemBase,
            { phase: "pre_call", currentUser: message },
          )
        : [
            ...(systemBase ? [{ role: "system" as const, content: systemBase }] : []),
            { role: "user" as const, content: message },
          ];

    try {
      this.deps.trace?.write({ type: "run_start", runId: run.id, kind: "chat", sessionId });
      const useSmart =
        !forceClient && this.deps.smartModelRouter && this.deps.modelOrchestrator;

      let content: string;
      let clientName: string | undefined;
      let modelName: string | undefined;
      let location: string | undefined;
      let latencyMs = 0;
      let usage: unknown;
      let routerDecision: unknown;
      let collaborationRunId: string | undefined;
      let executionStrategy: string | undefined;
      let fallbackCount: number | undefined;
      let fallbackLogIds: string[] | undefined;

      if (useSmart) {
        const routerInput = buildRouterInputFromChat({
          message,
          sessionId,
          sensitive: payload.sensitive,
          qualityMode: payload.qualityMode,
          taskType: taskTypeParsed.taskType as ModelTaskType | undefined,
          allowCollaboration: payload.allowCollaboration,
          forceSingleModel: payload.forceSingleModel,
          hasAttachments: payload.hasAttachments,
          attachmentTypes: payload.attachmentTypes,
          contextTokenEstimate: estimateRouterContextTokens(messages),
          recentMessagesCount: messages.length,
          maxCostUsd: payload.maxCostUsd,
          spentCostUsd: payload.spentCostUsd,
        });
        const smartRouter = this.deps.smartModelRouter!;
        const chatOrchestrator = this.deps.modelOrchestrator!;
        const routed = smartRouter.routeDetailed(routerInput);
        const decision = routed.decision;
        const promptStrategy = defaultPromptStrategyBuilder.build({
          decision,
          routingContext: routed.routingContext,
          userInput: message,
          qualityMode: routerInput.qualityMode,
        });
        const chatMessages = messages.filter(
          (m): m is { role: "system" | "user" | "assistant"; content: string } =>
            m.role === "system" || m.role === "user" || m.role === "assistant",
        );
        const orchestrated = await chatOrchestrator.run({
          routerDecision: decision,
          userInput: message,
          sessionId,
          localOnly: routerInput.localOnly,
          temperature: promptStrategy.temperature,
          renderedPrompt: {
            systemSectionsText: applyPromptStrategyToSystemText(systemBase, promptStrategy),
            finalMessages: chatMessages,
          },
        });
        content = orchestrated.finalAnswer;
        clientName = orchestrated.clientName;
        modelName = orchestrated.modelName;
        location = orchestrated.location;
        latencyMs = Math.round(orchestrated.latencyMs ?? 0);
        usage = orchestrated.usage;
        routerDecision = {
          id: decision.id,
          taskType: decision.taskType,
          executionStrategy: decision.executionStrategy,
          selectedModelId: decision.selectedModelId,
          draftModelId: decision.draftModelId,
          reviewModelId: decision.reviewModelId,
          risk: decision.risk,
          reason: decision.reason,
          requireUserConfirmation: decision.requireUserConfirmation,
          contextSignals: decision.contextSignals,
          promptStrategy: {
            temperature: promptStrategy.temperature,
            responseStyle: promptStrategy.responseStyle,
            hints: promptStrategy.hints,
          },
        };
        collaborationRunId = orchestrated.collaborationRunId;
        executionStrategy = orchestrated.usedStrategy;
        fallbackCount = orchestrated.fallbackCount;
        fallbackLogIds = orchestrated.fallbackLogIds;
      } else {
        const response = await this.deps.modelRouter.chat(
          { messages, temperature: 0.3 },
          {
            forceClient,
            sensitive: payload.sensitive,
            taskType: taskTypeParsed.taskType,
          },
        );
        content = response.content;
        clientName = response.clientName;
        modelName = response.modelName;
        location = response.location;
        latencyMs = Math.round(response.latencyMs);
        usage = response.usage;
      }

      if (persist && sessionId) {
        this.deps.contextManager.saveAssistantMessage(sessionId, content);
      }

      const finalized =
        persist && sessionId
          ? await this.deps.contextManager.finalizeTurn(sessionId, message)
          : undefined;

      const responseBody = {
        runId: run.id,
        routed: !forceClient,
        clientName,
        modelName,
        location,
        latencyMs,
        usage,
        content,
        sessionId,
        routerDecision,
        collaborationRunId,
        executionStrategy,
        fallbackCount,
        fallbackLogIds,
        compressed: finalized?.compressed ? true : undefined,
        phase: finalized?.postCall.phase,
        contextPackage: finalized?.postCall.contextPackage,
        renderedPrompt: finalized?.postCall.renderedPrompt,
      };

      this.deps.runs.update(run.id, {
        status: "completed",
        resultJson: JSON.stringify({ content }),
      });
      this.deps.trace?.write({ type: "run_end", runId: run.id, kind: "chat", status: "completed" });

      return { status: 200, body: responseBody };
    } catch (error) {
      this.deps.runs.update(run.id, { status: "failed", error: String(error) });
      this.deps.trace?.write({ type: "run_end", runId: run.id, kind: "chat", status: "failed" });
      if (error instanceof RouterError) {
        return { status: 503, body: { error: error.message, code: error.code, runId: run.id } };
      }
      return { status: 502, body: { error: `调用失败：${String(error)}`, runId: run.id } };
    }
  }

  /** SSE：单次对话流式（token + done）；走 ModelRouter 以支持 onToken。 */
  async runChatStream(body: unknown, emit: (event: ChatStreamEvent) => void): Promise<void> {
    const payload = (body ?? {}) as {
      clientName?: string;
      message?: string;
      system?: string;
      sensitive?: boolean;
      taskType?: string;
      sessionId?: string;
      persist?: boolean;
      streamTokens?: boolean;
    };
    const message = (payload.message ?? "").trim();
    if (!message) throw new Error("message 不能为空");

    const taskTypeParsed = parseModelTaskTypeOrError(payload.taskType);
    if (!taskTypeParsed.ok) throw new Error(taskTypeParsed.error);

    const forceClient =
      payload.clientName && payload.clientName !== "__default__" ? payload.clientName : undefined;

    const persist = payload.persist !== false;
    const sessionId = persist ? this.ensureSession(payload.sessionId, "网页对话") : undefined;

    const run = this.deps.runs.create({
      kind: "chat",
      status: "running",
      sessionId,
      goal: message.slice(0, 200),
      correlation: { runId: "", sessionId },
    });
    this.deps.runs.update(run.id, {
      correlationJson: JSON.stringify(this.correlationFor(run.id, { sessionId })),
    });

    const systemBase = payload.system?.trim() ?? "";
    if (persist && sessionId) {
      this.deps.contextManager.saveUserMessage(sessionId, message);
    }

    const messages =
      persist && sessionId
        ? this.deps.contextManager.buildChatMessages(
            await this.deps.contextManager.restoreContextPackage(sessionId, message),
            systemBase,
            { phase: "pre_call", currentUser: message },
          )
        : [
            ...(systemBase ? [{ role: "system" as const, content: systemBase }] : []),
            { role: "user" as const, content: message },
          ];

    emit({ type: "run_start", runId: run.id, sessionId });

    const abortController = this.deps.agentRunRegistry.register(run.id, "chat");

    try {
      this.deps.trace?.write({ type: "run_start", runId: run.id, kind: "chat", sessionId });
      const response = await this.deps.modelRouter.chat(
        {
          messages,
          temperature: 0.3,
          onToken: payload.streamTokens
            ? (delta) => emit({ type: "token", delta })
            : undefined,
          signal: abortController.signal,
        },
        {
          forceClient,
          sensitive: payload.sensitive,
          taskType: taskTypeParsed.taskType,
        },
      );

      if (persist && sessionId) {
        this.deps.contextManager.saveAssistantMessage(sessionId, response.content);
        await this.deps.contextManager.finalizeTurn(sessionId, message);
      }

      this.deps.runs.update(run.id, {
        status: "completed",
        resultJson: JSON.stringify({ content: response.content }),
      });
      this.deps.trace?.write({ type: "run_end", runId: run.id, kind: "chat", status: "completed" });

      emit({
        type: "done",
        runId: run.id,
        sessionId,
        content: response.content,
        clientName: response.clientName,
        modelName: response.modelName,
        location: response.location,
        latencyMs: Math.round(response.latencyMs),
      });
    } catch (error) {
      if (isRunCancelledError(error)) {
        this.deps.runs.update(run.id, { status: "cancelled", error: "运行已取消" });
        this.deps.trace?.write({ type: "run_end", runId: run.id, kind: "chat", status: "cancelled" });
        emit({
          type: "done",
          runId: run.id,
          sessionId,
          content: "（运行已取消）",
          cancelled: true,
        });
        return;
      }
      this.deps.runs.update(run.id, { status: "failed", error: String(error) });
      this.deps.trace?.write({ type: "run_end", runId: run.id, kind: "chat", status: "failed" });
      emit({ type: "error", error: String(error), runId: run.id });
    } finally {
      this.deps.agentRunRegistry.unregister(run.id);
    }
  }
}
