import type { ModelTaskType } from "../model/taskType.js";
import { parseRunModeValue, type AgentRunMode } from "./RunPolicyTypes.js";
import { defaultWorkflowPlanner, type WorkflowPlan } from "./WorkflowPlanner.js";
import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";
import { defaultWorkflowRouter } from "./WorkflowRouter.js";
export type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";

export type IntentModeSource = "explicit" | "inferred";

export interface IntentRouteInput {
  requestedMode?: string;
  message?: string;
  taskType?: ModelTaskType;
}

export interface IntentRouteResult {
  mode: AgentRunMode;
  modeSource: IntentModeSource;
  intent: AgentIntentType;
  workflowType: AgentWorkflowType;
  workflowPlan: WorkflowPlan | null;
}

/**
 * 用户意图路由：统一入口下先识别内部意图，再映射到当前已实现的运行模式与预扫描工作流。
 */
export class IntentRouter {
  route(input: IntentRouteInput = {}): IntentRouteResult {
    const explicit = parseRunModeValue(input.requestedMode);
    const intent = explicit ? intentForExplicitMode(explicit) : this.inferIntent(input);
    const mode = explicit ?? modeForIntent(intent);
    const goal = input.message ?? "";
    return {
      mode,
      modeSource: explicit ? "explicit" : "inferred",
      intent,
      workflowType: defaultWorkflowRouter.routeIntent(intent).workflowType,
      workflowPlan: defaultWorkflowPlanner.plan(goal, mode),
    };
  }

  inferMode(input: IntentRouteInput): AgentRunMode {
    return modeForIntent(this.inferIntent(input));
  }

  inferIntent(input: IntentRouteInput): AgentIntentType {
    const text = normalizeText(input.message ?? "");
    if (!text && input.taskType === "codegen") return "edit";

    if (hasAny(text, ["先别改", "不要修改", "不做修改", "只读", "计划模式", "计划", "方案", "设计", "规划", "拆分任务", "实现步骤", "plan mode"])) {
      return "plan";
    }
    if (hasAny(text, ["审阅", "审查", "review", "代码质量", "架构问题", "潜在 bug"])) {
      return "review";
    }
    if (hasAny(text, ["测试", "编译", "构建", "build", "typecheck", "验证", "检查是否", "跑一下"])) {
      return "verify";
    }
    if (hasAny(text, ["运行", "执行", "安装", "启动", "npm run", "yarn", "pnpm", "python"])) {
      return "run";
    }
    if (hasAny(text, ["报错", "错误", "失败", "崩了", "修复这个问题", "debug", "调试", "排错"])) {
      return "debug";
    }
    if (hasAny(text, ["重构", "解耦", "循环引用", "强依赖", "架构调整", "refactor"])) {
      return "refactor";
    }
    if (hasAny(text, ["生成文件", "新建文件", "创建文件", "写一份", "新增文档", "generate file"])) {
      return "generate_file";
    }
    if (hasAny(text, ["修改", "补充完整", "改成", "替换", "直接实现", "开始优化", "继续完成", "实现"])) {
      return input.taskType === "codegen" ? "edit" : "edit";
    }
    if (hasAny(text, ["搜索", "查找", "定位", "引用", "在哪里", "找一下", "search"])) {
      return "search";
    }
    if (hasAny(text, ["总结", "概括", "当前项目进度", "项目如何", "summarize"])) {
      return "summarize";
    }
    if (input.taskType === "codegen") return "edit";
    return "answer";
  }
}

export const defaultIntentRouter = new IntentRouter();

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle.toLowerCase()));
}

function intentForExplicitMode(mode: AgentRunMode): AgentIntentType {
  if (mode === "plan") return "plan";
  if (mode === "implement") return "edit";
  if (mode === "debug") return "debug";
  if (mode === "review") return "review";
  return "answer";
}

function modeForIntent(intent: AgentIntentType): AgentRunMode {
  if (intent === "plan") return "plan";
  if (intent === "review") return "review";
  if (intent === "debug" || intent === "run" || intent === "verify") return "debug";
  if (intent === "edit" || intent === "refactor" || intent === "generate_file") return "implement";
  return "chat";
}
