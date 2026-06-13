import type { ContextManager } from "../context/ContextManager.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolPermission } from "./permissions.js";
import type { AgentToolStep } from "./toolStep.js";
import type { AgentRunMode, RunBudget } from "./RunPolicy.js";
import type { BudgetManager } from "./BudgetManager.js";
import { countSuccessfulPermissionUsage } from "./BudgetManager.js";
import {
  PLAN_WORKFLOW_STEP_IDS,
  type PlanWorkflowStepId,
} from "../orchestrator/planWorkflowConstants.js";
import type { RunStateLocationContext } from "../orchestrator/runStateLocation.js";

export interface PlanWorkflowOptions {
  registry: ToolRegistry;
  workspaceRoot: string;
  allowedPermissions: ToolPermission[];
  budget: RunBudget;
  budgetManager?: BudgetManager;
  trace?: TraceLogger;
  contextManager?: ContextManager;
  sessionId?: string;
  taskId?: string;
  requestId?: string;
}

export interface PlanWorkflowResult {
  steps: AgentToolStep[];
  modelContext: string;
}

export interface PlanWorkflowResumeContext {
  completedStepIds: readonly PlanWorkflowStepId[];
  priorSteps: AgentToolStep[];
  location?: RunStateLocationContext;
}

const WORKFLOW_TOOLS = PLAN_WORKFLOW_STEP_IDS;

/**
 * Plan/review mode deterministic read-only pre-scan.
 *
 * It keeps broad project analysis from spending one model turn per discovery tool.
 */
export class PlanWorkflow {
  constructor(private readonly options: PlanWorkflowOptions) {}

  async run(
    goal: string,
    mode: AgentRunMode,
    resume?: PlanWorkflowResumeContext,
  ): Promise<PlanWorkflowResult | undefined> {
    if (!shouldRunPlanWorkflow(goal, mode)) return undefined;
    if (!this.options.allowedPermissions.includes("read")) return undefined;

    const priorSteps = resume?.priorSteps ?? [];
    const completed = new Set(resume?.completedStepIds ?? []);
    const steps: AgentToolStep[] = [...priorSteps];

    const pendingCount = WORKFLOW_TOOLS.length - completed.size;
    const maxNewSteps = this.options.budgetManager
      ? this.options.budgetManager.remainingWorkflowSteps(steps, pendingCount)
      : Math.min(
          pendingCount,
          Math.max(0, this.options.budget.maxToolCalls - steps.length),
          Math.max(
            0,
            this.options.budget.maxReadCalls - countSuccessfulPermissionUsage(steps).readCalls,
          ),
        );
    if (maxNewSteps <= 0 && steps.length === 0) return undefined;
    if (maxNewSteps <= 0 && steps.length > 0) return buildResult(steps);

    let scanOutput = steps.find((s) => s.tool === "project_scan" && s.ok)?.output as
      | Record<string, unknown>
      | undefined;
    let locateOutput = steps.find((s) => s.tool === "locate_relevant_files" && s.ok)?.output;

    let newSteps = 0;
    for (const stepId of WORKFLOW_TOOLS) {
      if (completed.has(stepId)) continue;
      if (newSteps >= maxNewSteps) break;

      if (stepId === "project_scan") {
        const projectScan = await this.runTool(
          "project_scan",
          { root: ".", maxDepth: 3 },
          "计划/审阅模式固定预扫描：先识别项目结构、配置和重要入口。",
        );
        steps.push(projectScan);
        newSteps += 1;
        if (projectScan.ok) scanOutput = asRecord(projectScan.output);
        if (newSteps >= maxNewSteps) return buildResult(steps);
        continue;
      }

      if (stepId === "locate_relevant_files") {
        const possiblePaths = unique([
          ...readStringArray(scanOutput?.sourceRoots).slice(0, 8),
          ...(resume?.location?.searchPlan?.possiblePaths ?? []),
        ]).slice(0, 12);
        const locate = await this.runTool(
          "locate_relevant_files",
          {
            projectId: resume?.location?.projectId ?? "default",
            goal,
            mode,
            limit: 12,
            possiblePaths,
            keywords: resume?.location?.searchPlan?.keywords,
            possibleSymbols: resume?.location?.searchPlan?.possibleSymbols,
            resumeContext: resume?.location
              ? {
                  visitedFiles: resume.location.visitedFiles,
                  visitedDirs: resume.location.visitedDirs,
                  candidateFiles: resume.location.candidateFiles,
                  primaryFiles: resume.location.primaryFiles,
                  searchPlan: resume.location.searchPlan,
                }
              : undefined,
            locateBudget: {
              maxSearchCalls: 3,
              maxListCalls: 1,
              maxReadForLocationCalls: 2,
              maxCandidateFiles: 16,
              maxPrimaryFiles: 8,
            },
          },
          resume?.location
            ? "计划/审阅续跑：在已保存 searchPlan/visitedFiles 基础上继续定位。"
            : "计划/审阅模式固定预扫描：根据目标定位 primaryFiles 和 candidateFiles。",
        );
        steps.push(locate);
        newSteps += 1;
        if (locate.ok) locateOutput = locate.output;
        if (newSteps >= maxNewSteps) return buildResult(steps);
        continue;
      }

      if (stepId === "context_pack") {
        const files = filesFromLocateOutput(locateOutput);
        if (files.length > 0) {
          const pack = await this.runTool(
            "context_pack",
            {
              files,
              maxFiles: 8,
              maxTokens: 12_000,
              includeSummaries: true,
              includeImportantSections: true,
            },
            "计划/审阅模式固定预扫描：一次性打包相关文件上下文，避免连续 read_file。",
          );
          steps.push(pack);
          newSteps += 1;
        }
      }
    }

    return buildResult(steps);
  }

  private async runTool(
    toolName: string,
    input: Record<string, unknown>,
    thought: string,
  ): Promise<AgentToolStep> {
    const tool = this.options.registry.get(toolName);
    const step: AgentToolStep = {
      iteration: 0,
      tool: toolName,
      input,
      permission: tool?.permission,
      thought,
      ok: false,
    };

    this.options.trace?.write({
      type: "agent_tool",
      tool: toolName,
      iteration: 0,
      runId: this.options.requestId,
      sessionId: this.options.sessionId,
      taskId: this.options.taskId,
      workflow: "plan",
    });

    const result = await this.options.registry.run(toolName, input, {
      workspaceRoot: this.options.workspaceRoot,
      allowedPermissions: this.options.allowedPermissions,
      taskId: this.options.taskId,
      sessionId: this.options.sessionId,
      requestId: this.options.requestId,
    });

    if (result.ok) {
      const output =
        this.options.contextManager?.compactToolOutput(toolName, result.output) ?? result.output;
      this.saveToolMessage(toolName, output);
      return { ...step, ok: true, output, durationMs: result.durationMs };
    }

    const failed = {
      ...step,
      error: `[${result.code}] ${result.error}`,
      blocked: result.code === "permission_denied",
      durationMs: result.durationMs,
    };
    this.saveToolMessage(toolName, { error: failed.error, code: result.code });
    return failed;
  }

  private saveToolMessage(toolName: string, output: unknown): void {
    if (!this.options.contextManager || !this.options.sessionId) return;
    this.options.contextManager.saveToolMessage(
      this.options.sessionId,
      `PlanWorkflow 工具「${toolName}」执行结果（JSON）：\n${JSON.stringify(output)}`,
    );
  }
}

export function shouldRunPlanWorkflow(goal: string, mode: AgentRunMode): boolean {
  if (mode !== "plan" && mode !== "review") return false;
  const text = goal.toLowerCase();
  const asksForAnalysis =
    /分析|审阅|检查|扫描|梳理|找出|定位|查看|生成.*计划|升级.*计划|review|scan|analyze/.test(goal) ||
    text.includes("plan");
  const projectScope =
    /当前项目|项目|代码|模块|结构|仓库|路由|上下文|工具|日志|配置|todolist|agent|src|docs|tests/.test(goal) ||
    text.includes("codebase");
  const explicitNoWorkflow = /不要使用工具|不允许使用工具|不要扫描|不允许扫描|不要读取文件|不允许读取文件/.test(goal);
  return asksForAnalysis && projectScope && !explicitNoWorkflow;
}

function buildResult(steps: AgentToolStep[]): PlanWorkflowResult {
  return {
    steps,
    modelContext: renderPlanWorkflowContext(steps),
  };
}

function renderPlanWorkflowContext(steps: AgentToolStep[]): string {
  const blocks = steps.map((step, index) => {
    const payload = step.ok ? step.output : { error: step.error, blocked: step.blocked };
    return [
      `## ${index + 1}. ${step.tool}`,
      `thought: ${step.thought ?? ""}`,
      `input: ${JSON.stringify(step.input)}`,
      `output: ${JSON.stringify(payload)}`,
    ].join("\n");
  });
  return [
    "计划/审阅模式预扫描结果（PlanWorkflow，只读、确定性执行）：",
    "请优先基于这些结果生成最终计划或审阅结论；如果信息足够，请直接输出 final，不要重复执行同类扫描。",
    ...blocks,
  ].join("\n\n");
}

function filesFromLocateOutput(output: unknown): string[] {
  const record = asRecord(output);
  return [
    ...pathArray(record?.primaryFiles),
    ...pathArray(record?.candidateFiles),
  ].filter((item, index, arr) => item && arr.indexOf(item) === index).slice(0, 8);
}

function pathArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      const record = asRecord(item);
      return typeof record?.path === "string" ? record.path : undefined;
    })
    .filter((item): item is string => Boolean(item));
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
