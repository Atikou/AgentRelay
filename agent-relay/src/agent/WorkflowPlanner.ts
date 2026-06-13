import type { AgentRunMode } from "./RunPolicy.js";

/** 预扫描工作流可执行的定位类工具步骤。 */
export const WORKFLOW_TOOL_NAMES = [
  "project_scan",
  "locate_relevant_files",
  "context_pack",
] as const;

export type WorkflowToolName = (typeof WORKFLOW_TOOL_NAMES)[number];

export type AgentWorkflowId = "plan_prescan" | "implement_locate";

export interface WorkflowPlan {
  id: AgentWorkflowId;
  reason: string;
  steps: readonly WorkflowToolName[];
  contextHeader: string;
  contextHint: string;
}

const EXPLICIT_NO_WORKFLOW_RE =
  /不要使用工具|不允许使用工具|不要扫描|不允许扫描|不要读取文件|不允许读取文件/;

function hasProjectScope(goal: string): boolean {
  const text = goal.toLowerCase();
  return (
    /当前项目|项目|代码|模块|结构|仓库|路由|上下文|工具|日志|配置|todolist|agent|src|docs|tests/.test(
      goal,
    ) || text.includes("codebase")
  );
}

function explicitNoWorkflow(goal: string): boolean {
  return EXPLICIT_NO_WORKFLOW_RE.test(goal);
}

/**
 * 根据模式与目标选择确定性预扫描工作流（PlanWorkflow 执行器消费）。
 */
export class WorkflowPlanner {
  plan(goal: string, mode: AgentRunMode): WorkflowPlan | null {
    if (explicitNoWorkflow(goal)) return null;

    const planPrescan = this.planPrescan(goal, mode);
    if (planPrescan) return planPrescan;

    return this.planImplementLocate(goal, mode);
  }

  private planPrescan(goal: string, mode: AgentRunMode): WorkflowPlan | null {
    if (mode !== "plan" && mode !== "review") return null;
    const text = goal.toLowerCase();
    const asksForAnalysis =
      /分析|审阅|检查|扫描|梳理|找出|定位|查看|生成.*计划|升级.*计划|review|scan|analyze/.test(
        goal,
      ) || text.includes("plan");
    if (!asksForAnalysis || !hasProjectScope(goal)) return null;

    return {
      id: "plan_prescan",
      reason: "计划/审阅模式下的项目分析请求，执行完整只读预扫描。",
      steps: ["project_scan", "locate_relevant_files", "context_pack"],
      contextHeader: "计划/审阅模式预扫描结果（WorkflowPlanner → PlanWorkflow，只读、确定性执行）：",
      contextHint:
        "请优先基于这些结果生成最终计划或审阅结论；如果信息足够，请直接输出 final，不要重复执行同类扫描。",
    };
  }

  private planImplementLocate(goal: string, mode: AgentRunMode): WorkflowPlan | null {
    if (mode !== "implement" && mode !== "debug") return null;
    const wantsCodeWork =
      /修改|实现|修复|添加|重构|更新|编写|调整|fix|implement|refactor|add|update|patch|debug/.test(
        goal,
      );
    const hasTargetHint =
      /\.[tj]sx?|src\/|模块|文件|函数|类|工具|路由|循环|AgentLoop|ToolRegistry|handler/.test(
        goal,
      );
    if (!wantsCodeWork || (!hasTargetHint && !hasProjectScope(goal))) return null;

    return {
      id: "implement_locate",
      reason: "实现/调试模式下的代码变更请求，先定位相关文件并打包上下文。",
      steps: ["locate_relevant_files", "context_pack"],
      contextHeader: "实现/调试模式预定位结果（WorkflowPlanner → PlanWorkflow，只读、确定性执行）：",
      contextHint:
        "请优先基于已定位文件与 context_pack 结果进行修改或调试；避免重复 list_files/search_text 试探。",
    };
  }
}

export const defaultWorkflowPlanner = new WorkflowPlanner();

export function shouldRunAgentWorkflow(goal: string, mode: AgentRunMode): boolean {
  return defaultWorkflowPlanner.plan(goal, mode) !== null;
}

/** @deprecated 使用 shouldRunAgentWorkflow；保留兼容 plan/review 专用判断。 */
export function shouldRunPlanWorkflow(goal: string, mode: AgentRunMode): boolean {
  const workflow = defaultWorkflowPlanner.plan(goal, mode);
  return workflow?.id === "plan_prescan";
}
