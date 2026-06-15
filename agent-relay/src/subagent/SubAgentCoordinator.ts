import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { LoopChatFn } from "../agent/AgentLoop.js";
import { arbitrateSubAgentConflicts } from "./SubAgentArbitrator.js";
import { normalizeDelegatedTask } from "./delegatedTask.js";
import { ExecutionRouter } from "./ExecutionRouter.js";
import { aggregateSubAgentResultsStructured, SubAgentRunner, type SubAgentRunnerDeps } from "./SubAgentRunner.js";
import type { DelegatedTask } from "./delegatedTask.js";
import type { SubAgentBatchOptions, SubAgentBatchResult } from "./types.js";
import { attemptAutoMergeWriteConflicts, formatWriteMergeSummary } from "./writeConflictAutoMerge.js";
import type { SubAgentCancelResult, SubAgentRunRegistry, SubAgentRunningRecord } from "./SubAgentRunRegistry.js";

const executionRouter = new ExecutionRouter();

export class SubAgentCoordinator {
  private readonly runner: SubAgentRunner;

  constructor(private readonly deps: SubAgentRunnerDeps) {
    this.runner = new SubAgentRunner(deps);
  }

  runDelegated(task: DelegatedTask, opts?: Omit<import("./types.js").DelegatedTaskRunOptions, "task">) {
    const route = executionRouter.route({
      goal: task.goal,
      contextSnippet: task.input,
      forceDelegate: true,
      needsWrite: task.toolPolicy?.writeAllowed,
      needsShell: task.toolPolicy?.shellAllowed,
    });
    return this.runner.runDelegated({
      task,
      ...opts,
      executionRoute: route.mode === "delegate" ? route : opts?.executionRoute,
    });
  }

  cancel(subAgentId: string): SubAgentCancelResult | undefined {
    return this.deps.runRegistry?.cancel(subAgentId);
  }

  listRunning(): SubAgentRunningRecord[] {
    return this.deps.runRegistry?.listRunning() ?? [];
  }

  async runBatch(options: SubAgentBatchOptions): Promise<SubAgentBatchResult> {
    if (!options.tasks.length) throw new Error("tasks 不能为空");

    const parentTaskId = options.parentTaskId ?? randomUUID();
    const entries = options.tasks.map((t) => {
      const task = normalizeDelegatedTask(t);
      const route = executionRouter.route({
        goal: task.goal,
        contextSnippet: task.input,
        forceDelegate: true,
        needsWrite: task.toolPolicy?.writeAllowed,
      });
      return { task, route: route.mode === "delegate" ? route : undefined };
    });

    const start = performance.now();
    const settled = await Promise.all(
      entries.map((entry) =>
        this.runner.runDelegated({
          task: entry.task,
          parentTaskId,
          grantedPermissions: options.grantedPermissions,
          timeoutMs: options.timeoutMs,
          sensitive: options.sensitive,
          dispatchDepth: options.dispatchDepth,
          executionRoute: entry.route,
        }),
      ),
    );

    let aggregate = aggregateSubAgentResultsStructured(settled);
    const summaryGoal = options.tasks.map((t) => t.goal).join(" | ");

    if (options.arbitrateConflicts) {
      const arbitrationChat = resolveArbitrationChat(this.deps, options.sensitive, summaryGoal);
      const arbitration = await arbitrateSubAgentConflicts(arbitrationChat, {
        task: summaryGoal,
        results: settled,
        textConflicts: aggregate.conflicts,
        writeConflicts: aggregate.writeConflicts,
        sensitive: options.sensitive,
      });
      if (arbitration.applied) {
        aggregate = {
          ...aggregate,
          arbitration: {
            applied: arbitration.applied,
            summary: arbitration.summary,
            writeFilePicks: arbitration.writeFilePicks,
          },
          mergedAnswer: `${aggregate.mergedAnswer}\n\n## 模型仲裁\n${arbitration.summary}`,
        };
      } else if (arbitration.skippedReason) {
        aggregate = { ...aggregate, arbitration: { applied: false, summary: "", skippedReason: arbitration.skippedReason } };
      }
    }

    if (options.autoMergeWrites && aggregate.writeConflicts.length > 0) {
      const storage = this.deps.registry.getStorage();
      if (storage) {
        const writeMerges = await attemptAutoMergeWriteConflicts(
          storage,
          this.deps.workspaceRoot,
          aggregate.writeConflicts,
          settled,
          {
            arbitrationSummary: aggregate.arbitration?.summary,
            writeFilePickStrategy: options.writeFilePickStrategy ?? "arbitration",
          },
        );
        const unresolved = aggregate.writeConflicts.filter(
          (conflict) => writeMerges.find((attempt) => attempt.path === conflict.path)?.status !== "merged",
        );
        const mergeSummary = formatWriteMergeSummary(writeMerges);
        aggregate = {
          ...aggregate,
          writeConflicts: unresolved,
          writeMerges,
          mergedAnswer: mergeSummary ? `${aggregate.mergedAnswer}\n\n${mergeSummary}` : aggregate.mergedAnswer,
        };
      }
    }

    return {
      parentTaskId,
      results: settled,
      summary: aggregate.mergedAnswer,
      aggregate,
      durationMs: Math.round(performance.now() - start),
    };
  }
}

function resolveArbitrationChat(deps: SubAgentRunnerDeps, sensitive?: boolean, goal?: string): LoopChatFn {
  if (deps.createChatForDelegatedTask) {
    const taskObj = normalizeDelegatedTask({
      goal: goal ?? "仲裁子任务冲突",
      instructions: "只读复核多子任务冲突并给出建议",
      input: "",
    });
    return deps.createChatForDelegatedTask(taskObj, { sensitive, parentTaskId: randomUUID() });
  }
  return deps.chat;
}
