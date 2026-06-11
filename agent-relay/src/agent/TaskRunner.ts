import type { TraceLogger } from "../trace/TraceLogger.js";
import { MODE_PERMISSIONS, type ToolPermission } from "./permissions.js";
import {
  indexPlanSteps,
  propagateDependencyBlocks,
  readyPendingSteps,
  validateTaskGraph,
} from "./taskGraph.js";
import type { Plan, PlanStep } from "./types.js";

export interface StepContext {
  signal?: AbortSignal;
}

export interface StepResult {
  output?: string;
}

/** 步骤执行器：任务模式下「如何执行一个步骤」的可插拔实现。 */
export interface StepExecutor {
  execute(step: PlanStep, ctx: StepContext): Promise<StepResult>;
}

export interface TaskRunnerOptions {
  executor: StepExecutor;
  /** 需要确认的步骤的确认回调；返回 false 则该步骤阻塞。 */
  confirm?: (step: PlanStep) => Promise<boolean>;
  /** 跳过确认，全部自动同意（dry-run / 测试用）。 */
  autoConfirm?: boolean;
  /** 本次运行允许的权限边界，默认任务模式的全集。 */
  allowedPermissions?: ToolPermission[];
  onUpdate?: (plan: Plan) => void;
  trace?: TraceLogger;
}

/**
 * 任务模式执行器：按计划逐步执行，维护步骤状态机，支持确认、中断、重试。
 * 真实副作用由注入的 StepExecutor 负责（工具系统落地后接入）。
 */
export class TaskRunner {
  private cancelled = false;

  constructor(
    private readonly plan: Plan,
    private readonly options: TaskRunnerOptions,
  ) {}

  getPlan(): Plan {
    return this.plan;
  }

  /** 请求中断：当前步骤完成后停止，剩余步骤标记为 cancelled。 */
  cancel(): void {
    this.cancelled = true;
  }

  /**
   * 按 dependsOn 依赖图调度：无依赖或依赖已完成的步骤在同一波次并行执行。
   * `blocked` 时继续调度其他可执行分支；`failed` 后不再启动新波次；依赖失败/阻塞会传播。
   */
  async run(): Promise<Plan> {
    validateTaskGraph(this.plan.steps);
    const byId = indexPlanSteps(this.plan.steps);

    let haltOnFailure = false;
    while (!haltOnFailure) {
      if (this.cancelled) {
        for (const step of this.plan.steps) {
          if (step.status === "pending") step.status = "cancelled";
        }
        break;
      }

      propagateDependencyBlocks(this.plan.steps, byId);
      const ready = readyPendingSteps(this.plan.steps, byId);
      if (ready.length === 0) break;

      const outcomes = await Promise.all(ready.map((step) => this.runStep(step)));
      propagateDependencyBlocks(this.plan.steps, byId);
      if (outcomes.some((o) => o === "failed")) {
        haltOnFailure = true;
      }
    }

    this.emit();
    return this.plan;
  }

  /** 把某步骤重置为 pending 并从该步骤起继续执行。 */
  async retryFrom(stepId: string): Promise<Plan> {
    const index = this.plan.steps.findIndex((s) => s.id === stepId);
    if (index < 0) throw new Error(`未找到步骤：${stepId}`);
    this.cancelled = false;
    for (let i = index; i < this.plan.steps.length; i += 1) {
      const step = this.plan.steps[i]!;
      if (step.status !== "completed") {
        step.status = "pending";
        step.error = undefined;
      }
    }
    return this.run();
  }

  private async runStep(step: PlanStep): Promise<PlanStep["status"]> {
    // 1) 权限边界：超出本次允许权限集的步骤直接阻塞。
    const allowed: string[] = this.options.allowedPermissions ?? MODE_PERMISSIONS.task;
    const disallowed = step.requiredPermissions.filter((p) => !allowed.includes(p));
    if (disallowed.length > 0) {
      step.status = "blocked";
      step.error = `任务模式不允许的权限：${disallowed.join(", ")}`;
      this.emit();
      return step.status;
    }

    // 2) 确认门：需要确认且未自动同意时，征询确认。
    if (step.needsConfirmation && !this.options.autoConfirm) {
      const approved = this.options.confirm ? await this.options.confirm(step) : false;
      if (!approved) {
        step.status = "blocked";
        step.error = "等待用户确认";
        this.emit();
        return step.status;
      }
    }

    // 3) 执行。
    step.status = "running";
    step.error = undefined;
    this.emit();
    try {
      const result = await this.options.executor.execute(step, {});
      step.result = result.output;
      step.status = "completed";
      this.options.trace?.write({ type: "task_step", step: step.id, status: "completed" });
    } catch (error) {
      step.status = "failed";
      step.error = String(error);
      this.options.trace?.write({
        type: "task_step",
        step: step.id,
        status: "failed",
        error: String(error),
      });
    }
    this.emit();
    return step.status;
  }

  private emit(): void {
    this.options.onUpdate?.(this.plan);
  }
}

/**
 * 默认 dry-run 执行器：不产生任何副作用，仅把步骤标记为已模拟执行。
 * 用于在工具系统就绪前演示任务模式的控制流。
 */
export class DryRunExecutor implements StepExecutor {
  async execute(step: PlanStep): Promise<StepResult> {
    return { output: `(dry-run) 已模拟执行：${step.title}` };
  }
}
