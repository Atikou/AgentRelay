import type { TraceLogger } from "../trace/TraceLogger.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolPermission } from "../core/permissions.js";
import type { PlanExecutionMode } from "../plan/PlanActivationWorkflow.js";
import { DryRunExecutor, TaskRunner, type StepExecutor } from "./TaskRunner.js";
import { PlanStepAgentExecutor, type AgentLoopRunFn } from "./PlanStepAgentExecutor.js";
import { ToolStepExecutor } from "./ToolStepExecutor.js";
import type { Plan, PlanStep } from "./types.js";
import type { StepResult } from "./TaskRunner.js";

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
  requireToolBinding?: boolean;
  executionMode?: PlanExecutionMode;
  runAgent?: AgentLoopRunFn;
  planGoal?: string;
  onStepLifecycle?: (event: {
    type: "started" | "completed" | "failed";
    step: PlanStep;
    result?: StepResult;
    error?: string;
  }) => void;
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
      onStepLifecycle: input.onStepLifecycle,
    });
  }

  private createExecutor(input: TaskExecutionWorkflowRunInput): StepExecutor {
    if (input.executor) return input.executor;
    if (input.dryRun) {
      return new DryRunExecutor({ requireToolBinding: input.requireToolBinding });
    }
    const mode = input.executionMode ?? "static";
    if (mode === "agent_loop" && input.runAgent) {
      return new PlanStepAgentExecutor({
        runAgent: input.runAgent,
        sessionId: input.sessionId,
        parentRunId: input.runId,
        planGoal: input.planGoal ?? input.plan.goal,
        autoConfirm: input.autoConfirm,
      });
    }
    return new ToolStepExecutor({
      registry: this.options.registry,
      workspaceRoot: this.options.workspaceRoot,
      taskId: input.taskId,
      sessionId: input.sessionId,
      requestId: input.runId,
      projectAllowedPermissions: this.options.projectAllowedPermissions,
      requireToolBinding: input.requireToolBinding,
    });
  }
}
