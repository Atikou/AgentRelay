import { performance } from "node:perf_hooks";

import { withTimeout } from "../util/timeout.js";
import type {
  ChatMessage,
  ChatRequest,
  ModelClient,
  ModelResponse,
  ModelToolSpec,
  ToolCall,
} from "./types.js";

export interface AnthropicOptions {
  name: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /** Anthropic API 版本头，默认 2023-06-01。 */
  apiVersion?: string;
  /** messages API 必填 max_tokens，未指定单次请求时的默认值。 */
  maxTokens?: number;
  timeoutMs?: number;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicMessagesResponse {
  model?: string;
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Anthropic（Claude）远程客户端，使用其原生 Messages API。
 *
 * 与 OpenAI 协议的差异已在此处理：
 *  - system 是顶层参数，不放进 messages。
 *  - messages 仅 user/assistant；tool 结果以 user 消息的 tool_result 块表示。
 *  - 鉴权用 x-api-key 头，并需 anthropic-version 头。
 *  - max_tokens 为必填。
 */
export class AnthropicClient implements ModelClient {
  public readonly name: string;
  public readonly model: string;
  public readonly location = "remote" as const;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly defaultMaxTokens: number;
  private readonly timeoutMs: number;

  constructor(options: AnthropicOptions) {
    this.name = options.name;
    this.model = options.model;
    this.apiKey = options.apiKey ?? "";
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.apiVersion = options.apiVersion ?? "2023-06-01";
    this.defaultMaxTokens = options.maxTokens ?? 4096;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": this.apiVersion,
    };
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;

    const { signal, cancel } = withTimeout(Math.min(this.timeoutMs, 8_000));
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        method: "GET",
        headers: this.headers(),
        signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      cancel();
    }
  }

  async chat(request: ChatRequest): Promise<ModelResponse> {
    const { signal, cancel } = withTimeout(this.timeoutMs, request.signal);
    const start = performance.now();

    const system = request.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");

    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.model,
          max_tokens: request.maxTokens ?? this.defaultMaxTokens,
          ...(system ? { system } : {}),
          messages: toAnthropicMessages(request.messages),
          tools: toAnthropicTools(request.tools),
          temperature: request.temperature,
        }),
        signal,
      });

      if (!response.ok) {
        const detail = await safeReadText(response);
        throw new Error(`Anthropic 请求失败：${response.status} ${detail}`);
      }

      const data = (await response.json()) as AnthropicMessagesResponse;
      const latencyMs = performance.now() - start;
      const blocks = data.content ?? [];

      return {
        content: blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join(""),
        toolCalls: parseToolCalls(blocks),
        clientName: this.name,
        modelName: data.model ?? this.model,
        location: this.location,
        latencyMs,
        usage: {
          inputTokens: data.usage?.input_tokens,
          outputTokens: data.usage?.output_tokens,
        },
      };
    } finally {
      cancel();
    }
  }
}

function toAnthropicMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      result.push({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content },
        ],
      });
      continue;
    }
    result.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    });
  }
  return result;
}

function toAnthropicTools(tools?: ModelToolSpec[]): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

function parseToolCalls(blocks: AnthropicContentBlock[]): ToolCall[] {
  return blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: b.id ?? "",
      name: b.name ?? "",
      arguments: b.input ?? {},
    }));
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
