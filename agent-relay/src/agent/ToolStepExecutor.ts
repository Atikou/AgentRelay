import type { ToolPermission } from "../core/permissions.js";
import { MODE_PERMISSIONS } from "../core/permissions.js";
import { resolveEffectivePermissions } from "../policy/PermissionPolicy.js";
import { StepExecutionError, type StepContext, type StepExecutor, type StepResult } from "./TaskRunner.js";
import type { PlanStep } from "./types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";

export interface ToolStepExecutorOptions {
  registry: ToolRegistry;
  workspaceRoot: string;
  taskId?: string;
  sessionId?: string;
  requestId?: string;
  allowedPermissions?: ToolPermission[];
  projectAllowedPermissions?: ToolPermission[];
}

/**
 * 工具驱动的步骤执行器：把绑定了 `tool` 的计划步骤交给工具注册表真实执行。
 * 未绑定工具的步骤视为手工/说明步骤，仅返回提示而不产生副作用。
 */
export class ToolStepExecutor implements StepExecutor {
  private readonly allowed: ToolPermission[];

  constructor(private readonly options: ToolStepExecutorOptions) {
    const resolved = resolveEffectivePermissions({
      projectAllowed: options.projectAllowedPermissions,
      modeAllowed: MODE_PERMISSIONS.task,
      modeSource: "task.mode",
      taskAllowed: options.allowedPermissions,
      taskSource: "task.allowedPermissions",
    });
    this.allowed =
      resolved.allowed.length > 0
        ? resolved.allowed
        : (options.allowedPermissions ?? MODE_PERMISSIONS.task);
  }

  async execute(step: PlanStep, ctx: StepContext): Promise<StepResult> {
    if (!step.tool) {
      return { output: `（无绑定工具，跳过实际执行）${step.title}` };
    }

    const toolCallId = this.makeToolCallId(step);
    const result = await this.options.registry.run(step.tool, step.toolInput ?? {}, {
      workspaceRoot: this.options.workspaceRoot,
      taskId: this.options.taskId,
      sessionId: this.options.sessionId,
      requestId: this.options.requestId,
      toolCallId,
      signal: ctx.signal,
      allowedPermissions: this.allowed,
    });

    if (!result.ok) {
      throw new StepExecutionError(
        `[${result.tool}] ${result.code}/${result.category}: ${result.error}`,
        result.toolCallId,
      );
    }
    return { output: summarize(result.output), toolCallId: result.toolCallId };
  }

  private makeToolCallId(step: PlanStep): string {
    const prefix = this.options.requestId ?? this.options.taskId ?? this.options.sessionId ?? "task";
    return `${prefix}:step-${step.id}:${step.tool ?? "manual"}`;
  }
}

/** 把工具输出压成简短文本，避免大输出塞满步骤结果。 */
function summarize(output: unknown): string {
  const json = JSON.stringify(output);
  if (json.length <= 600) return json;
  return `${json.slice(0, 600)}…(已截断，共 ${json.length} 字符)`;
}
