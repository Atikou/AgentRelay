import { performance } from "node:perf_hooks";

import { withTimeout } from "../util/timeout.js";
import { normalizeMessagesForModelTransport } from "./messageBoundary.js";
import type {
  ChatMessage,
  ChatRequest,
  ModelClient,
  ModelResponse,
  ModelToolSpec,
  ToolCall,
} from "./types.js";

export interface OllamaOptions {
  name: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  think?: boolean | "low" | "medium" | "high";
}

interface OllamaToolCall {
  function?: {
    name?: string;
    arguments?: unknown;
  };
}

interface OllamaChatResponse {
  model?: string;
  message?: {
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

/**
 * 本地 Ollama 客户端，直接调用其原生 /api/chat。
 *
 * 覆盖需求「1. 模型接入」中本地模型运行时（Ollama）的接入。
 * Ollama 同时提供 OpenAI 兼容端点，但原生端点对工具调用与 token 统计支持更直接。
 */
export class OllamaClient implements ModelClient {
  public readonly name: string;
  public readonly model: string;
  public readonly location = "local" as const;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly think: boolean | "low" | "medium" | "high";

  constructor(options: OllamaOptions) {
    this.name = options.name;
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.think = options.think ?? false;
  }

  async isAvailable(): Promise<boolean> {
    const { signal, cancel } = withTimeout(Math.min(this.timeoutMs, 5_000));
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, { signal });
      if (!response.ok) return false;
      const data = (await response.json()) as OllamaTagsResponse;
      const names = (data.models ?? []).map((m) => m.name ?? m.model ?? "");
      // 服务在线即视为可用；若拉到模型列表，则进一步确认目标模型已安装。
      if (names.length === 0) return true;
      return names.some((name) => name === this.model || name.startsWith(`${this.model}:`));
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
      if (request.onToken) {
        const response = await fetch(`${this.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.model,
            messages: toOllamaMessages(request.messages),
            tools: toOllamaTools(request.tools),
            think: this.think,
            stream: true,
            options: {
              temperature: request.temperature,
              num_predict: request.maxTokens,
            },
          }),
          signal,
        });

        if (!response.ok) {
          const detail = await safeReadText(response);
          throw new Error(`Ollama 请求失败：${response.status} ${detail}`);
        }
        if (!response.body) {
          throw new Error("Ollama 流式响应无 body");
        }

        let content = "";
        const toolCalls: ToolCall[] = [];
        let modelName = this.model;
        let promptEval = 0;
        let evalCount = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const chunk = JSON.parse(trimmed) as OllamaChatResponse & {
              message?: { content?: string; tool_calls?: OllamaToolCall[] };
            };
            if (chunk.model) modelName = chunk.model;
            const delta = chunk.message?.content ?? "";
            if (delta) {
              content += delta;
              request.onToken(delta);
            }
            if (chunk.message?.tool_calls?.length) {
              toolCalls.push(...parseToolCalls(chunk.message.tool_calls));
            }
            if (chunk.prompt_eval_count != null) promptEval = chunk.prompt_eval_count;
            if (chunk.eval_count != null) evalCount = chunk.eval_count;
          }
        }

        return {
          content,
          toolCalls,
          clientName: this.name,
          modelName,
          location: this.location,
          latencyMs: performance.now() - start,
          usage: { inputTokens: promptEval, outputTokens: evalCount },
        };
      }

      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: toOllamaMessages(request.messages),
          tools: toOllamaTools(request.tools),
          // Qwen3/DeepSeek-R1 等 thinking 模型可用配置开启；默认关闭以避免
          // 输出预算全写进 message.thinking，导致 message.content 为空。
          think: this.think,
          stream: false,
          options: {
            temperature: request.temperature,
            num_predict: request.maxTokens,
          },
        }),
        signal,
      });

      if (!response.ok) {
        const detail = await safeReadText(response);
        throw new Error(`Ollama 请求失败：${response.status} ${detail}`);
      }

      const data = (await response.json()) as OllamaChatResponse;
      const latencyMs = performance.now() - start;

      return {
        content: data.message?.content ?? "",
        toolCalls: parseToolCalls(data.message?.tool_calls),
        clientName: this.name,
        modelName: data.model ?? this.model,
        location: this.location,
        latencyMs,
        usage: {
          inputTokens: data.prompt_eval_count,
          outputTokens: data.eval_count,
        },
      };
    } finally {
      cancel();
    }
  }
}

function toOllamaMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return normalizeMessagesForModelTransport(messages).map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.name ? { name: m.name } : {}),
  }));
}

function toOllamaTools(tools?: ModelToolSpec[]): Array<Record<string, unknown>> | undefined {
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

function parseToolCalls(toolCalls: OllamaToolCall[] | undefined): ToolCall[] {
  if (!toolCalls) return [];
  return toolCalls.map((call, index) => ({
    // Ollama 不返回 tool call id，这里合成一个稳定 id。
    id: `ollama_tool_${index}`,
    name: call.function?.name ?? "",
    arguments: call.function?.arguments ?? {},
  }));
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
