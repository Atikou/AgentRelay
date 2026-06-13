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

const PLAN_INTENT_RE =
  /\u5148\u522b\u6539|\u4e0d\u8981\u4fee\u6539|\u4e0d\u505a\u4fee\u6539|\u53ea\u8bfb|\u8ba1\u5212\u6a21\u5f0f|\u8ba1\u5212|\u65b9\u6848|\u8bbe\u8ba1|\u89c4\u5212|\u62c6\u5206\u4efb\u52a1|\u5b9e\u73b0\u6b65\u9aa4|plan mode/;
const REVIEW_INTENT_RE =
  /\u5ba1\u9605|\u5ba1\u67e5|review|\u4ee3\u7801\u8d28\u91cf|\u67b6\u6784\u95ee\u9898|\u6f5c\u5728 bug/;
const VERIFY_INTENT_RE =
  /\u6d4b\u8bd5|\u7f16\u8bd1|\u6784\u5efa|build|typecheck|\u9a8c\u8bc1|\u68c0\u67e5\u662f\u5426|\u8dd1\u4e00\u4e0b/;
const RUN_INTENT_RE =
  /\u8fd0\u884c|\u6267\u884c|\u5b89\u88c5|\u542f\u52a8|npm run|yarn|pnpm|python/;
const DEBUG_INTENT_RE =
  /\u62a5\u9519|\u9519\u8bef|\u5931\u8d25|\u5d29\u4e86|\u4fee\u590d\u8fd9\u4e2a\u95ee\u9898|debug|\u8c03\u8bd5|\u6392\u9519/;
const REFACTOR_INTENT_RE =
  /\u91cd\u6784|\u89e3\u8026|\u5faa\u73af\u5f15\u7528|\u5f3a\u4f9d\u8d56|\u67b6\u6784\u8c03\u6574|refactor/;
const GENERATE_FILE_INTENT_RE =
  /(\u751f\u6210|\u65b0\u5efa|\u521b\u5efa|\u65b0\u589e|\u5199).{0,20}\u6587\u4ef6|generate file/;
const EDIT_INTENT_RE =
  /\u4fee\u6539|\u8865\u5145\u5b8c\u6574|\u6539\u6210|\u66ff\u6362|\u76f4\u63a5\u5b9e\u73b0|\u5f00\u59cb\u4f18\u5316|\u7ee7\u7eed\u5b8c\u6210|\u5b9e\u73b0/;
const SEARCH_INTENT_RE =
  /\u641c\u7d22|\u67e5\u627e|\u5b9a\u4f4d|\u5f15\u7528|\u5728\u54ea\u91cc|\u627e\u4e00\u4e0b|search/;
const SUMMARIZE_INTENT_RE =
  /\u603b\u7ed3|\u6982\u62ec|\u5f53\u524d\u9879\u76ee\u8fdb\u5ea6|\u9879\u76ee\u5982\u4f55|summarize/;

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
    const unicodeIntent = inferUnicodeIntent(text);
    if (unicodeIntent) return unicodeIntent;

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

function inferUnicodeIntent(text: string): AgentIntentType | undefined {
  if (PLAN_INTENT_RE.test(text)) return "plan";
  if (REVIEW_INTENT_RE.test(text)) return "review";
  if (VERIFY_INTENT_RE.test(text)) return "verify";
  if (RUN_INTENT_RE.test(text)) return "run";
  if (DEBUG_INTENT_RE.test(text)) return "debug";
  if (REFACTOR_INTENT_RE.test(text)) return "refactor";
  if (GENERATE_FILE_INTENT_RE.test(text)) return "generate_file";
  if (EDIT_INTENT_RE.test(text)) return "edit";
  if (SEARCH_INTENT_RE.test(text)) return "search";
  if (SUMMARIZE_INTENT_RE.test(text)) return "summarize";
  return undefined;
}

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
