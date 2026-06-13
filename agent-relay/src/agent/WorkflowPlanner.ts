import type { AgentIntentType } from "./IntentTypes.js";
import type { AgentRunMode } from "./RunPolicyTypes.js";

/** Deterministic read-only workflow tools that can run before the model turn. */
export const WORKFLOW_TOOL_NAMES = [
  "project_scan",
  "locate_relevant_files",
  "context_pack",
] as const;

export type WorkflowToolName = (typeof WORKFLOW_TOOL_NAMES)[number];

export type AgentWorkflowId =
  | "plan_prescan"
  | "implement_locate"
  | "edit_locate"
  | "generate_file_locate";

export interface WorkflowPlan {
  id: AgentWorkflowId;
  reason: string;
  steps: readonly WorkflowToolName[];
  contextHeader: string;
  contextHint: string;
}

const EXPLICIT_NO_WORKFLOW_RE =
  /不要使用工具|不允许使用工具|不要扫描|不允许扫描|不要读取文件|不允许读取文件/;
const EXPLICIT_NO_WORKFLOW_UNICODE_RE =
  /\u4e0d\u8981\u4f7f\u7528\u5de5\u5177|\u4e0d\u5141\u8bb8\u4f7f\u7528\u5de5\u5177|\u4e0d\u8981\u626b\u63cf|\u4e0d\u5141\u8bb8\u626b\u63cf|\u4e0d\u8981\u8bfb\u53d6\u6587\u4ef6|\u4e0d\u5141\u8bb8\u8bfb\u53d6\u6587\u4ef6/;
const PROJECT_SCOPE_UNICODE_RE =
  /\u5f53\u524d\u9879\u76ee|\u9879\u76ee|\u4ee3\u7801|\u6a21\u5757|\u7ed3\u6784|\u4ed3\u5e93|\u8def\u7531|\u4e0a\u4e0b\u6587|\u5de5\u5177|\u65e5\u5fd7|\u914d\u7f6e|todolist|agent|src|docs|tests/;
const TARGET_HINT_UNICODE_RE =
  /\.[tj]sx?|src\/|\u6a21\u5757|\u6587\u4ef6|\u51fd\u6570|\u7c7b|\u5de5\u5177|\u8def\u7531|\u5faa\u73af|AgentLoop|ToolRegistry|handler/;
const ANALYSIS_UNICODE_RE =
  /\u5206\u6790|\u5ba1\u9605|\u68c0\u67e5|\u626b\u63cf|\u68b3\u7406|\u627e\u51fa|\u5b9a\u4f4d|\u67e5\u770b|\u751f\u6210.*\u8ba1\u5212|\u5347\u7ea7.*\u8ba1\u5212|review|scan|analyze/;
const GENERATE_FILE_UNICODE_RE =
  /(\u751f\u6210|\u521b\u5efa|\u65b0\u589e|\u5199).{0,20}\u6587\u4ef6|generate.*file|create.*file|new file/;
const EDIT_UNICODE_RE =
  /\u4fee\u6539|\u66f4\u65b0|\u8c03\u6574|\u4fee\u590d|\u8865\u4e01|\u6539\u52a8|\u7f16\u8f91|fix|edit|update|patch|change/;
const CODE_WORK_UNICODE_RE =
  /\u4fee\u6539|\u5b9e\u73b0|\u4fee\u590d|\u6dfb\u52a0|\u91cd\u6784|\u66f4\u65b0|\u7f16\u5199|\u8c03\u6574|fix|implement|refactor|add|update|patch|debug/;

function hasProjectScope(goal: string): boolean {
  const text = goal.toLowerCase();
  return (
    /当前项目|项目|代码|模块|结构|仓库|路由|上下文|工具|日志|配置|todolist|agent|src|docs|tests/.test(
      goal,
    ) ||
    PROJECT_SCOPE_UNICODE_RE.test(goal) ||
    text.includes("codebase")
  );
}

function hasTargetHint(goal: string): boolean {
  return (
    /\.[tj]sx?|src\/|模块|文件|函数|类|工具|路由|循环|AgentLoop|ToolRegistry|handler/.test(goal) ||
    TARGET_HINT_UNICODE_RE.test(goal)
  );
}

function explicitNoWorkflow(goal: string): boolean {
  return EXPLICIT_NO_WORKFLOW_RE.test(goal) || EXPLICIT_NO_WORKFLOW_UNICODE_RE.test(goal);
}

/**
 * Selects deterministic pre-model workflows. These workflows are intentionally read-only:
 * they locate files and package context, then the normal agent loop decides what to do next.
 */
export class WorkflowPlanner {
  plan(goal: string, mode: AgentRunMode, intent?: AgentIntentType): WorkflowPlan | null {
    if (explicitNoWorkflow(goal)) return null;

    const planPrescan = this.planPrescan(goal, mode);
    if (planPrescan) return planPrescan;

    const generateFileLocate = this.planGenerateFileLocate(goal, mode, intent);
    if (generateFileLocate) return generateFileLocate;

    const editLocate = this.planEditLocate(goal, mode, intent);
    if (editLocate) return editLocate;

    return this.planImplementLocate(goal, mode);
  }

  private planPrescan(goal: string, mode: AgentRunMode): WorkflowPlan | null {
    if (mode !== "plan" && mode !== "review") return null;
    const text = goal.toLowerCase();
    const asksForAnalysis =
      /分析|审阅|检查|扫描|梳理|找出|定位|查看|生成.*计划|升级.*计划|review|scan|analyze/.test(
        goal,
      ) ||
      ANALYSIS_UNICODE_RE.test(goal) ||
      text.includes("plan");
    if (!asksForAnalysis || !hasProjectScope(goal)) return null;

    return {
      id: "plan_prescan",
      reason: "计划/审阅模式下的项目分析请求，执行完整只读预扫描。",
      steps: ["project_scan", "locate_relevant_files", "context_pack"],
      contextHeader: "计划/审阅模式内部预扫描结果（只读、确定性执行）：",
      contextHint:
        "请优先基于这些结果生成最终计划或审阅结论；如果信息足够，请直接输出 final，不要重复执行同类扫描。",
    };
  }

  private planGenerateFileLocate(
    goal: string,
    mode: AgentRunMode,
    intent?: AgentIntentType,
  ): WorkflowPlan | null {
    if (mode !== "implement") return null;
    const wantsGenerateFile =
      intent === "generate_file" ||
      /生成.*文件|创建.*文件|新增.*文件|写.*文件|generate.*file|create.*file|new file/.test(
        goal,
      ) ||
      GENERATE_FILE_UNICODE_RE.test(goal);
    if (!wantsGenerateFile || (!hasTargetHint(goal) && !hasProjectScope(goal))) return null;

    return {
      id: "generate_file_locate",
      reason:
        "generateFileWorkflow read-only prelocation: locate the target directory and nearby conventions before creating a file.",
      steps: ["locate_relevant_files", "context_pack"],
      contextHeader: "generateFileWorkflow read-only prelocation result:",
      contextHint:
        "Use the located files and context_pack result to infer naming, exports, tests, and documentation before creating a new file.",
    };
  }

  private planEditLocate(
    goal: string,
    mode: AgentRunMode,
    intent?: AgentIntentType,
  ): WorkflowPlan | null {
    if (mode !== "implement" && mode !== "debug") return null;
    const wantsEdit =
      intent === "edit" ||
      /修改|更新|调整|修复|补丁|改动|编辑|fix|edit|update|patch|change/.test(goal) ||
      EDIT_UNICODE_RE.test(goal);
    if (!wantsEdit || (!hasTargetHint(goal) && !hasProjectScope(goal))) return null;

    return {
      id: "edit_locate",
      reason:
        "editWorkflow read-only prelocation: locate relevant files and pack context before any write-capable action.",
      steps: ["locate_relevant_files", "context_pack"],
      contextHeader: "editWorkflow read-only prelocation result:",
      contextHint:
        "Use the located files and context_pack result to draft the edit plan first. Do not call write-capable tools until permissions and the concrete patch are clear.",
    };
  }

  private planImplementLocate(goal: string, mode: AgentRunMode): WorkflowPlan | null {
    if (mode !== "implement" && mode !== "debug") return null;
    const wantsCodeWork =
      /修改|实现|修复|添加|重构|更新|编写|调整|fix|implement|refactor|add|update|patch|debug/.test(
        goal,
      ) || CODE_WORK_UNICODE_RE.test(goal);
    if (!wantsCodeWork || (!hasTargetHint(goal) && !hasProjectScope(goal))) return null;

    return {
      id: "implement_locate",
      reason: "实现/调试模式下的代码变更请求，先定位相关文件并打包上下文。",
      steps: ["locate_relevant_files", "context_pack"],
      contextHeader: "实现/调试模式内部预定位结果（只读、确定性执行）：",
      contextHint:
        "请优先基于已定位文件与 context_pack 结果进行修改或调试；避免重复 list_files/search_text 试探。",
    };
  }
}

export const defaultWorkflowPlanner = new WorkflowPlanner();

export function shouldRunAgentWorkflow(goal: string, mode: AgentRunMode): boolean {
  return defaultWorkflowPlanner.plan(goal, mode) !== null;
}

/** @deprecated Use shouldRunAgentWorkflow; retained for plan/review-only checks. */
export function shouldRunPlanWorkflow(goal: string, mode: AgentRunMode): boolean {
  const workflow = defaultWorkflowPlanner.plan(goal, mode);
  return workflow?.id === "plan_prescan";
}
