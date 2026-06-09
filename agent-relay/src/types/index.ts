/**
 * 全局共享类型出口。
 * 目前主要复用模型层类型；随着里程碑推进，任务、工具、上下文等类型会在此聚合。
 */
export type {
  ModelClient,
  ModelResponse,
  ModelLocation,
  ChatMessage,
  ChatRequest,
  ChatRole,
  ModelToolSpec,
  ToolCall,
  TokenUsage,
} from "../model/types.js";
