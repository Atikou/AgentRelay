import type { NotificationQueue } from "../background/NotificationQueue.js";
import type { RunStore } from "../orchestrator/RunStore.js";
import type { TraceLogger } from "../trace/TraceLogger.js";

export interface StartupRecoverySummary {
  interruptedRuns: number;
  pendingNotifications: number;
  recoveredAt: string;
}

/** 启动时将悬挂 running Run 标记失败，并统计未消费通知（不自动重放 Agent）。 */
export function recoverOnStartup(deps: {
  runs: RunStore;
  notificationQueue: NotificationQueue;
  trace?: TraceLogger;
}): StartupRecoverySummary {
  const interrupted = deps.runs.list({ status: "running", limit: 500 });
  for (const run of interrupted) {
    deps.runs.update(run.id, {
      status: "failed",
      error: "进程重启导致运行中断（startupRecovery）",
    });
    deps.trace?.write({
      type: "startup_recovery_run",
      runId: run.id,
      kind: run.kind,
      previousStatus: "running",
    });
  }

  const pendingNotifications = deps.notificationQueue.listPending().length;
  if (interrupted.length > 0 || pendingNotifications > 0) {
    deps.trace?.write({
      type: "startup_recovery_summary",
      interruptedRuns: interrupted.length,
      pendingNotifications,
    });
  }

  return {
    interruptedRuns: interrupted.length,
    pendingNotifications,
    recoveredAt: new Date().toISOString(),
  };
}
