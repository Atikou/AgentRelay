import type { ToolPermission } from "./permissions.js";
import type { StepContext, StepExecutor, StepResult } from "./TaskRunner.js";
import type { PlanStep } from "./types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";

export interface ToolStepExecutorOptions {
  registry: ToolRegistry;
  workspaceRoot: string;
  taskId?: string;
  sessionId?: string;
  requestId?: string;
  allowedPermissions?: ToolPermission[];
}

/**
 * 工具驱动的步骤执行器：把绑定了 `tool` 的计划步骤交给工具注册表真实执行。
 * 未绑定工具的步骤视为手工/说明步骤，仅返回提示而不产生副作用。
 */
export class ToolStepExecutor implements StepExecutor {
  constructor(private readonly options: ToolStepExecutorOptions) {}

  async execute(step: PlanStep, ctx: StepContext): Promise<StepResult> {
    if (!step.tool) {
      return { output: `（无绑定工具，跳过实际执行）${step.title}` };
    }

    const result = await this.options.registry.run(step.tool, step.toolInput ?? {}, {
      workspaceRoot: this.options.workspaceRoot,
      taskId: this.options.taskId,
      sessionId: this.options.sessionId,
      requestId: this.options.requestId,
      signal: ctx.signal,
      allowedPermissions: this.options.allowedPermissions,
    });

    if (!result.ok) {
      throw new Error(`[${result.tool}] ${result.code}: ${result.error}`);
    }
    return { output: summarize(result.output) };
  }
}

/** 把工具输出压成简短文本，避免大输出塞满步骤结果。 */
function summarize(output: unknown): string {
  const json = JSON.stringify(output);
  if (json.length <= 600) return json;
  return `${json.slice(0, 600)}…(已截断，共 ${json.length} 字符)`;
}
