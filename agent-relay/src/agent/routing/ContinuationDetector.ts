import { isAgentStepFailureFeedback } from "../agentFailureFeedback.js";
import type { AgentIntentType } from "../IntentTypes.js";
import type { TaskContext } from "../task/TaskContext.js";

export type ContinuationKind = "continuation" | "new_task" | "uncertain";

export interface ContinuationDetectionResult {
  kind: ContinuationKind;
  reason: string;
  inheritIntent?: AgentIntentType;
  inheritWorkflowType?: TaskContext["workflowType"];
}

const CONTINUATION_ELIGIBLE_INTENTS = new Set<AgentIntentType>([
  "edit",
  "debug",
  "run",
  "verify",
  "refactor",
  "plan",
  "generate_file",
]);

export function isContinuationEligibleIntent(intent: AgentIntentType): boolean {
  return CONTINUATION_ELIGIBLE_INTENTS.has(intent);
}

export function isExplicitNewTaskMessage(message?: string): boolean {
  const text = (message ?? "").trim();
  if (!text) return false;
  return /(换个问题|新问题|另外问|不说这个|换个话题|说点别的|别管刚才|不管上面)/i.test(text);
}

export function isShortContinuationMessage(message?: string): boolean {
  const text = (message ?? "").trim();
  if (!text) return false;
  if (text.length > 24) return false;
  return /(继续|接着|按这个|按上面|就这样|开始|执行|改吧|修一下|再试|好的|ok|go|继续做)/i.test(text);
}

function isSupplementaryFailureInfo(message: string, ctx?: TaskContext): boolean {
  if (!ctx?.lastFailure && ctx?.currentPhase !== "failed") return false;
  return (
    isAgentStepFailureFeedback(message) ||
    /\[error\]|ENOENT|Exception|Traceback|stack trace|at\s+\S+:\d+:/i.test(message) ||
    (message.length > 40 && message.includes("\n"))
  );
}

/**
 * 判断用户消息是否延续当前会话任务。
 * 计划→执行交接由 planHandoff 处理，此处不对 plan 短句做 execute 跃迁。
 */
export function detectContinuation(message: string, ctx?: TaskContext): ContinuationDetectionResult {
  const text = message.trim();
  if (!text) return { kind: "uncertain", reason: "空消息" };

  if (isExplicitNewTaskMessage(text)) {
    return { kind: "new_task", reason: "用户明确表示切换新任务" };
  }

  if (!ctx || !ctx.isActive || !isContinuationEligibleIntent(ctx.intent)) {
    return { kind: "uncertain", reason: "无活跃任务上下文" };
  }

  if (ctx.intent === "plan" && isShortContinuationMessage(text)) {
    return { kind: "uncertain", reason: "计划会话短句需走 planHandoff" };
  }

  if (isAgentStepFailureFeedback(text)) {
    return {
      kind: "continuation",
      reason: "粘贴 Agent 工具失败步骤",
      inheritIntent: ctx.intent,
      inheritWorkflowType: ctx.workflowType,
    };
  }

  if (isSupplementaryFailureInfo(text, ctx)) {
    return {
      kind: "continuation",
      reason: "补充失败或日志信息",
      inheritIntent: ctx.intent,
      inheritWorkflowType: ctx.workflowType,
    };
  }

  if (isShortContinuationMessage(text)) {
    return {
      kind: "continuation",
      reason: "短句续写",
      inheritIntent: ctx.intent,
      inheritWorkflowType: ctx.workflowType,
    };
  }

  if (ctx.currentPhase === "failed" || ctx.lastFailure) {
    if (text.length <= 240) {
      return {
        kind: "continuation",
        reason: "上一轮失败后补充说明",
        inheritIntent: ctx.intent,
        inheritWorkflowType: ctx.workflowType,
      };
    }
  }

  return { kind: "uncertain", reason: "未识别为明确延续信号" };
}

/** 活跃任务存在时，避免 legacy answer 把会话打回只读 chat。 */
export function shouldInheritActiveTaskOnUncertain(
  ctx: TaskContext | undefined,
  fallbackIntent: AgentIntentType,
): boolean {
  if (!ctx?.isActive || !isContinuationEligibleIntent(ctx.intent)) return false;
  if (ctx.intent === "plan") return false;
  if (fallbackIntent === "answer" || fallbackIntent === "summarize" || fallbackIntent === "search") {
    return true;
  }
  return false;
}
