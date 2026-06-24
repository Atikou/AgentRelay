import type { ModelTaskType } from "../../model/taskType.js";
import type { IntentDecision } from "./IntentDecision.js";

export interface AIIntentClassifierInput {
  message: string;
  taskType?: ModelTaskType;
  sessionId?: string;
}

/**
 * AI 结构化意图分类（P2）。
 * 当前为占位：返回 null 表示不确定，由 LegacyIntentFallback 接管。
 * 接入后须双轨记录 AI vs legacy 差异，且不得输出权限授权结论。
 */
export function classifyIntentWithAI(_input: AIIntentClassifierInput): IntentDecision | null {
  return null;
}
