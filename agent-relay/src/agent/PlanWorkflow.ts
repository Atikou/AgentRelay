import type { ContextManager } from "../context/ContextManager.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolPermission } from "./permissions.js";
import type { AgentToolStep } from "./toolStep.js";
import type { AgentRunMode, RunBudget } from "./RunPolicy.js";

export interface PlanWorkflowOptions {
  registry: ToolRegistry;
  workspaceRoot: string;
  allowedPermissions: ToolPermission[];
  budget: RunBudget;
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

const WORKFLOW_TOOLS = ["project_scan", "locate_relevant_files", "context_pack"] as const;

/**
 * Plan/review mode deterministic read-only pre-scan.
 *
 * It keeps broad project analysis from spending one model turn per discovery tool.
 */
export class PlanWorkflow {
  constructor(private readonly options: PlanWorkflowOptions) {}

  async run(goal: string, mode: AgentRunMode): Promise<PlanWorkflowResult | undefined> {
    if (!shouldRunPlanWorkflow(goal, mode)) return undefined;
    if (!this.options.allowedPermissions.includes("read")) return undefined;

    const maxSteps = Math.min(
      WORKFLOW_TOOLS.length,
      this.options.budget.maxToolCalls,
      this.options.budget.maxReadCalls,
    );
    if (maxSteps <= 0) return undefined;

    const steps: AgentToolStep[] = [];
    const projectScan = await this.runTool(
      "project_scan",
      { root: ".", maxDepth: 3 },
      "计划/审阅模式固定预扫描：先识别项目结构、配置和重要入口。",
    );
    steps.push(projectScan);
    if (steps.length >= maxSteps) return buildResult(steps);

    const scanOutput = projectScan.ok ? asRecord(projectScan.output) : undefined;
    const possiblePaths = readStringArray(scanOutput?.sourceRoots).slice(0, 8);
    const locate = await this.runTool(
      "locate_relevant_files",
      {
        goal,
        mode,
        limit: 12,
        possiblePaths,
        locateBudget: {
          maxSearchCalls: 3,
          maxListCalls: 1,
          maxReadForLocationCalls: 2,
          maxCandidateFiles: 16,
          maxPrimaryFiles: 8,
        },
      },
      "计划/审阅模式固定预扫描：根据目标定位 primaryFiles 和 candidateFiles。",
    );
    steps.push(locate);
    if (steps.length >= maxSteps) return buildResult(steps);

    const files = filesFromLocateOutput(locate.output);
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

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
