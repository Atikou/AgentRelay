import type { ModelClientConfig } from "../config/types.js";
import { AnthropicClient } from "./AnthropicClient.js";
import { OllamaClient } from "./OllamaClient.js";
import { OpenAICompatibleClient } from "./OpenAICompatibleClient.js";
import type { ModelClient } from "./types.js";

/** 从单条配置解析出实际 API key（优先环境变量）。 */
function resolveApiKey(config: ModelClientConfig): string | undefined {
  if (config.apiKeyEnv) {
    const fromEnv = process.env[config.apiKeyEnv];
    if (fromEnv && fromEnv.length > 0) return fromEnv;
  }
  return config.apiKey;
}

/** 根据一条客户端配置创建对应的 ModelClient 实例。 */
export function createModelClient(config: ModelClientConfig): ModelClient {
  switch (config.provider) {
    case "ollama":
      return new OllamaClient({
        name: config.name,
        model: config.model,
        baseUrl: config.baseUrl,
        timeoutMs: config.timeoutMs,
        think: config.think,
      });
    case "openai-compatible":
      return new OpenAICompatibleClient({
        name: config.name,
        model: config.model,
        location: config.location,
        baseUrl: config.baseUrl,
        apiKey: resolveApiKey(config),
        timeoutMs: config.timeoutMs,
      });
    case "anthropic":
      return new AnthropicClient({
        name: config.name,
        model: config.model,
        baseUrl: config.baseUrl,
        apiKey: resolveApiKey(config),
        apiVersion: config.apiVersion,
        maxTokens: config.maxTokens,
        timeoutMs: config.timeoutMs,
      });
    default: {
      const exhaustive: never = config.provider;
      throw new Error(`未知的模型 provider：${String(exhaustive)}`);
    }
  }
}

/** 根据配置列表批量创建客户端。 */
export function createModelClients(configs: ModelClientConfig[]): ModelClient[] {
  return configs.map(createModelClient);
}
