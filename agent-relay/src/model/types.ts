/**
 * 模型层公共类型。
 *
 * 这一层只关心「如何和一个模型对话」，不关心路由、任务、工具执行。
 * 路由（自主选择）会在后续基于 ModelClient 列表实现。
 */

export type ModelLocation = "local" | "remote";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** 工具消息或具名消息使用。 */
  name?: string;
  /** role 为 "tool" 时，对应触发该结果的 tool call id。 */
  toolCallId?: string;
}

/**
 * 发送给模型的工具规格（JSON Schema 描述参数）。
 * 注意：这只是「告诉模型有哪些工具」，真正可执行的工具定义属于 tools 模块。
 */
export interface ModelToolSpec {
  name: string;
  description: string;
  /** JSON Schema 对象。 */
  parameters: Record<string, unknown>;
}

/** 模型返回的一次工具调用请求。 */
export interface ToolCall {
  id: string;
  name: string;
  /** 已尽量解析为对象；解析失败时为原始字符串。 */
  arguments: unknown;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ModelToolSpec[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ModelResponse {
  content: string;
  toolCalls: ToolCall[];
  /** 实际响应的客户端名（用于路由追踪）。 */
  clientName: string;
  /** 实际使用的模型名。 */
  modelName: string;
  location: ModelLocation;
  latencyMs: number;
  usage?: TokenUsage;
}

/**
 * 统一模型客户端接口。
 * 本地（Ollama / LM Studio / vLLM）与远程（OpenAI / DeepSeek / ...）都实现它，
 * 从而对上层屏蔽不同厂商的请求、响应、错误格式差异。
 */
export interface ModelClient {
  readonly name: string;
  readonly location: ModelLocation;
  readonly model: string;

  /** 探测该模型当前是否可用（用于启动检查与路由降级）。 */
  isAvailable(): Promise<boolean>;

  chat(request: ChatRequest): Promise<ModelResponse>;
}
