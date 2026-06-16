import { performance } from "node:perf_hooks";

import type { RoutingStrategy } from "../config/types.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { MetricsRegistry } from "./MetricsRegistry.js";
import { prepareRemoteChatRequest } from "./prepareRemoteChatRequest.js";
import { orderCandidatesByTaskType, type ModelTaskType } from "./taskType.js";
import type { ChatRequest, ModelClient, ModelResponse } from "./types.js";

/** 每个客户端的计价信息（每 1k token 的美元价格）。 */
export interface ClientPricing {
  inputPer1k?: number;
  outputPer1k?: number;
}

export interface ModelRouterOptions {
  strategy: RoutingStrategy;
  fallback: boolean;
  metrics?: MetricsRegistry;
  trace?: TraceLogger;
  /** clientName -> 计价。 */
  pricing?: Map<string, ClientPricing>;
}

export interface RouteOptions {
  /** 覆盖默认策略。 */
  strategy?: RoutingStrategy;
  /** 敏感任务：仅允许本地模型。 */
  sensitive?: boolean;
  /** 指定客户端（绕过策略，仅用该客户端）。 */
  forceClient?: string;
  /**
   * 任务类型提示：simple 优先本地；reasoning/codegen/long_context 优先远程。
   * 在 sensitive / privacy-first 下仍仅本地。
   */
  taskType?: ModelTaskType;
}

/**
 * 模型路由器：根据策略与可用性「自主选择」模型，并在失败时降级到下一候选。
 *
 * 策略：
 *  - local-first  ：先本地后远程。
 *  - cloud-first  ：先远程后本地。
 *  - quality-first：当前等同先远程（强模型通常在远程）；后续可接入质量评分。
 *  - privacy-first：仅本地。
 * sensitive=true 时无论策略一律仅本地。
 * taskType 在敏感约束之后重排候选（覆盖 strategy 的 local/remote 顺序）。
 */
export class ModelRouter {
  constructor(
    private readonly clients: ModelClient[],
    private readonly options: ModelRouterOptions,
  ) {}

  /** 按策略与约束给出候选顺序（不含可用性探测，可用性通过实际调用失败来降级）。 */
  listCandidates(opts: RouteOptions = {}): ModelClient[] {
    if (opts.forceClient) {
      return this.clients.filter((c) => c.name === opts.forceClient);
    }

    const strategy = opts.strategy ?? this.options.strategy;
    const local = this.clients.filter((c) => c.location === "local");
    const remote = this.clients.filter((c) => c.location === "remote");

    if (opts.sensitive || strategy === "privacy-first") {
      return local;
    }

    const byTask = orderCandidatesByTaskType(opts.taskType, local, remote);
    if (byTask) return byTask;

    if (strategy === "cloud-first" || strategy === "quality-first") {
      return [...remote, ...local];
    }
    // local-first（默认）
    return [...local, ...remote];
  }

  async chat(request: ChatRequest, opts: RouteOptions = {}): Promise<ModelResponse> {
    const strategy = opts.strategy ?? this.options.strategy;
    let candidates = this.listCandidates(opts);

    if (candidates.length === 0) {
      throw new Error(
        opts.forceClient
          ? `未找到指定模型：${opts.forceClient}`
          : "没有满足当前策略的候选模型（可能要求仅本地但无本地模型）。",
      );
    }

    // 非 fallback 模式只尝试首选；forceClient 天然只有一个候选。
    if (!this.options.fallback && !opts.forceClient) {
      candidates = candidates.slice(0, 1);
    }

    const errors: string[] = [];

    for (const client of candidates) {
      const start = performance.now();
      try {
        const safeRequest = this.prepareRequestForClient(request, client);
        const response = await client.chat(safeRequest);
        const latencyMs = response.latencyMs || performance.now() - start;
        const costUsd = this.recordSuccess(client, response, latencyMs, strategy, request.messages.length, opts.taskType);
        return costUsd === undefined ? response : { ...response, costUsd };
      } catch (error) {
        const latencyMs = performance.now() - start;
        const message = `${client.name}: ${String(error)}`;
        errors.push(message);
        this.recordFailure(client, latencyMs, strategy, request.messages.length, String(error), opts.taskType);
      }
    }

    throw new Error(`所有候选模型均失败：\n${errors.join("\n")}`);
  }

  private prepareRequestForClient(request: ChatRequest, client: ModelClient): ChatRequest {
    return prepareRemoteChatRequest(request, client, this.options.trace);
  }

  private priceFor(clientName: string, inputTokens?: number, outputTokens?: number): number | undefined {
    const pricing = this.options.pricing?.get(clientName);
    if (!pricing) return undefined;
    const inCost = ((inputTokens ?? 0) / 1000) * (pricing.inputPer1k ?? 0);
    const outCost = ((outputTokens ?? 0) / 1000) * (pricing.outputPer1k ?? 0);
    return inCost + outCost;
  }

  private recordSuccess(
    client: ModelClient,
    response: ModelResponse,
    latencyMs: number,
    strategy: RoutingStrategy,
    contextMessages: number,
    taskType?: ModelTaskType,
  ): number | undefined {
    const costUsd = this.priceFor(
      client.name,
      response.usage?.inputTokens,
      response.usage?.outputTokens,
    );
    this.options.metrics?.record({
      clientName: client.name,
      model: response.modelName,
      location: client.location,
      success: true,
      latencyMs,
      contextMessages,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
      costUsd,
      strategy,
      taskType,
    });
    this.options.trace?.write({
      type: "model_call",
      success: true,
      client: client.name,
      model: response.modelName,
      location: client.location,
      latencyMs: Math.round(latencyMs),
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
      costUsd,
      strategy,
      taskType,
    });
    return costUsd;
  }

  private recordFailure(
    client: ModelClient,
    latencyMs: number,
    strategy: RoutingStrategy,
    contextMessages: number,
    error: string,
    taskType?: ModelTaskType,
  ): void {
    this.options.metrics?.record({
      clientName: client.name,
      model: client.model,
      location: client.location,
      success: false,
      latencyMs,
      contextMessages,
      strategy,
      taskType,
      error,
    });
    this.options.trace?.write({
      type: "model_call",
      success: false,
      client: client.name,
      model: client.model,
      location: client.location,
      latencyMs: Math.round(latencyMs),
      strategy,
      taskType,
      error,
    });
  }
}
