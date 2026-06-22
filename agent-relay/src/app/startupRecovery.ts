import type { NotificationQueue } from "../background/NotificationQueue.js";
import type { PausedRunStore } from "../agent/PausedRunStore.js";
import type { RunStore } from "../orchestrator/RunStore.js";
import type { TraceLogger } from "../trace/TraceLogger.js";

export interface StartupRecoverySummary {
  interruptedRuns: number;
  preservedPausedRuns: number;
  pendingNotifications: number;
  recoveredAt: string;
}

/** 启动时恢复控制面状态：暂停授权的 Run 继续等待，其余悬挂 running Run 标记失败。 */
export function recoverOnStartup(deps: {
  runs: RunStore;
  notificationQueue: NotificationQueue;
  trace?: TraceLogger;
  pausedRunStore?: PausedRunStore;
}): StartupRecoverySummary {
  const interrupted = deps.runs.list({ status: "running", limit: 500 });
  let failedInterruptedRuns = 0;
  let preservedPausedRuns = 0;

  for (const run of interrupted) {
    const paused = deps.pausedRunStore?.get(run.id);
    if (paused) {
      deps.runs.update(run.id, { status: "waiting_confirmation" });
      preservedPausedRuns += 1;
      deps.trace?.write({
        type: "startup_recovery_run",
        runId: run.id,
        kind: run.kind,
        previousStatus: "running",
        recoveredStatus: "waiting_confirmation",
      });
      continue;
    }

    deps.runs.update(run.id, {
      status: "failed",
      error: "进程重启导致运行中断（startupRecovery）",
    });
    failedInterruptedRuns += 1;
    deps.trace?.write({
      type: "startup_recovery_run",
      runId: run.id,
      kind: run.kind,
      previousStatus: "running",
      recoveredStatus: "failed",
    });
  }

  const pendingNotifications = deps.notificationQueue.listPending().length;
  if (failedInterruptedRuns > 0 || preservedPausedRuns > 0 || pendingNotifications > 0) {
    deps.trace?.write({
      type: "startup_recovery_summary",
      interruptedRuns: failedInterruptedRuns,
      preservedPausedRuns,
      pendingNotifications,
    });
  }

  return {
    interruptedRuns: failedInterruptedRuns,
    preservedPausedRuns,
    pendingNotifications,
    recoveredAt: new Date().toISOString(),
  };
}
