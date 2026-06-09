import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { performance } from "node:perf_hooks";

import { safeJsonParse, withTimeout } from "../util/timeout.js";
import type {
  ChatMessage,
  ChatRequest,
  ModelClient,
  ModelLocation,
  ModelResponse,
  ModelToolSpec,
  ToolCall,
} from "./types.js";

export interface OpenAICompatibleOptions {
  name: string;
  model: string;
  location: ModelLocation;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
}

/**
 * 适配所有 OpenAI-compatible 接口的模型客户端。
 *
 * 覆盖需求「1. 模型接入」的：
 *  - 远程：OpenAI、DeepSeek 以及其它兼容 /v1/chat/completions 的服务。
 *  - 本地：LM Studio、vLLM、以及 Ollama 的 OpenAI 兼容端点。
 */
export class OpenAICompatibleClient implements ModelClient {
  public readonly name: string;
  public readonly location: ModelLocation;
  public readonly model: string;

  private readonly client: OpenAI;
  private readonly timeoutMs: number;
  private readonly hasApiKey: boolean;

  constructor(options: OpenAICompatibleOptions) {
    this.name = options.name;
    this.model = options.model;
    this.location = options.location;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.hasApiKey = Boolean(options.apiKey && options.apiKey.length > 0);

    this.client = new OpenAI({
      // 本地服务通常不校验 key，但 SDK 要求非空，这里给占位值。
      apiKey: options.apiKey && options.apiKey.length > 0 ? options.apiKey : "not-needed",
      baseURL: options.baseUrl,
    });
  }

  async isAvailable(): Promise<boolean> {
    // 远程服务缺少 key 直接判为不可用，避免无意义的网络请求。
    if (this.location === "remote" && !this.hasApiKey) {
      return false;
    }

    const { signal, cancel } = withTimeout(Math.min(this.timeoutMs, 8_000));
    try {
      await this.client.models.list({ signal });
      return true;
    } catch {
      return false;
    } finally {
      cancel();
    }
  }

  async chat(request: ChatRequest): Promise<ModelResponse> {
    const { signal, cancel } = withTimeout(this.timeoutMs, request.signal);
    const start = performance.now();

    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: toOpenAIMessages(request.messages),
          tools: toOpenAITools(request.tools),
          temperature: request.temperature,
          max_tokens: request.maxTokens,
        },
        { signal },
      );

      const latencyMs = performance.now() - start;
      const choice = response.choices[0];
      const message = choice?.message;

      return {
        content: message?.content ?? "",
        toolCalls: parseToolCalls(message?.tool_calls),
        clientName: this.name,
        modelName: response.model ?? this.model,
        location: this.location,
        latencyMs,
        usage: {
          inputTokens: response.usage?.prompt_tokens,
          outputTokens: response.usage?.completion_tokens,
        },
      };
    } finally {
      cancel();
    }
  }
}

function toOpenAIMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m): ChatCompletionMessageParam => {
    switch (m.role) {
      case "tool":
        return {
          role: "tool",
          content: m.content,
          tool_call_id: m.toolCallId ?? "",
        };
      case "system":
        return { role: "system", content: m.content };
      case "assistant":
        return { role: "assistant", content: m.content };
      case "user":
      default:
        return { role: "user", content: m.content };
    }
  });
}

function toOpenAITools(tools?: ModelToolSpec[]): ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function parseToolCalls(
  toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined,
): ToolCall[] {
  if (!toolCalls) return [];
  const result: ToolCall[] = [];
  for (const call of toolCalls) {
    if (call.type !== "function") continue;
    result.push({
      id: call.id,
      name: call.function.name,
      arguments: safeJsonParse(call.function.arguments),
    });
  }
  return result;
}
