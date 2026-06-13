import type { ModelTaskType } from "../model/taskType.js";
import { parseRunMode, type AgentRunMode } from "./RunPolicy.js";
import { defaultWorkflowPlanner, type WorkflowPlan } from "./WorkflowPlanner.js";

export type IntentModeSource = "explicit" | "inferred";

export interface IntentRouteInput {
  requestedMode?: string;
  message?: string;
  taskType?: ModelTaskType;
}

export interface IntentRouteResult {
  mode: AgentRunMode;
  modeSource: IntentModeSource;
  workflowPlan: WorkflowPlan | null;
}

/**
 * 用户意图路由：解析运行模式并选择预扫描工作流（供 RunPolicyManager / PlanWorkflow 消费）。
 */
export class IntentRouter {
  route(input: IntentRouteInput = {}): IntentRouteResult {
    const explicit = parseRunMode(input.requestedMode);
    const mode = explicit ?? this.inferMode(input);
    const goal = input.message ?? "";
    return {
      mode,
      modeSource: explicit ? "explicit" : "inferred",
      workflowPlan: defaultWorkflowPlanner.plan(goal, mode),
    };
  }

  inferMode(input: IntentRouteInput): AgentRunMode {
    const text = input.message?.toLowerCase() ?? "";
    if (
      text.includes("计划模式") ||
      text.includes("只读") ||
      text.includes("不要修改") ||
      text.includes("不做修改") ||
      text.includes("先不要修改") ||
      text.includes("plan mode")
    ) {
      return "plan";
    }
    if (text.includes("审阅") || text.includes("review")) return "review";
    if (text.includes("调试") || text.includes("排错") || text.includes("debug")) return "debug";
    if (
      text.includes("实现模式") ||
      text.includes("修改") ||
      text.includes("实现") ||
      text.includes("implement")
    ) {
      return "implement";
    }
    if (input.taskType === "codegen") return "implement";
    return "chat";
  }
}

export const defaultIntentRouter = new IntentRouter();
