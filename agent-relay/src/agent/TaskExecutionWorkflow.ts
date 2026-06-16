import type { TraceLogger } from "../trace/TraceLogger.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolPermission } from "../core/permissions.js";
import { DryRunExecutor, TaskRunner, type StepExecutor } from "./TaskRunner.js";
import { ToolStepExecutor } from "./ToolStepExecutor.js";
import type { Plan } from "./types.js";

export type TaskResumeAction = "retry" | "skip" | "confirm";

export interface TaskExecutionWorkflowOptions {
  registry: ToolRegistry;
  workspaceRoot: string;
  projectAllowedPermissions?: ToolPermission[];
  trace?: TraceLogger;
}

export interface TaskExecutionWorkflowRunInput {
  plan: Plan;
  dryRun?: boolean;
  autoConfirm?: boolean;
  taskId?: string;
  sessionId?: string;
  runId?: string;
  onUpdate?: (plan: Plan) => void;
  executor?: StepExecutor;
}

export interface TaskExecutionWorkflowResumeInput extends TaskExecutionWorkflowRunInput {
  action: TaskResumeAction;
  stepId: string;
}

/**
 * Workflow-level entry for approved task execution.
 *
 * Orchestrator still owns run/task persistence and rollback policy; this class
 * owns the TaskRunner wiring so execution and resume share one path.
 */
export class TaskExecutionWorkflow {
  constructor(private readonly options: TaskExecutionWorkflowOptions) {}

  async run(input: TaskExecutionWorkflowRunInput): Promise<Plan> {
    return this.createRunner(input).run();
  }

  async resume(input: TaskExecutionWorkflowResumeInput): Promise<Plan> {
    return this.createRunner(input).resume(input.action, input.stepId);
  }

  createRunner(input: TaskExecutionWorkflowRunInput): TaskRunner {
    return new TaskRunner(input.plan, {
      executor: this.createExecutor(input),
      autoConfirm: input.autoConfirm ?? false,
      projectAllowedPermissions: this.options.projectAllowedPermissions,
      onUpdate: input.onUpdate,
      trace: this.options.trace,
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
    });
  }

  private createExecutor(input: TaskExecutionWorkflowRunInput): StepExecutor {
    if (input.executor) return input.executor;
    if (input.dryRun) return new DryRunExecutor();
    return new ToolStepExecutor({
      registry: this.options.registry,
      workspaceRoot: this.options.workspaceRoot,
      taskId: input.taskId,
      sessionId: input.sessionId,
      requestId: input.runId,
      projectAllowedPermissions: this.options.projectAllowedPermissions,
    });
  }
}
