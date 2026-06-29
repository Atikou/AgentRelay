import type { BudgetLedgerSnapshot } from "./BudgetManager.js";
import type { CompletionGuardResult } from "./completion/CompletionFinalGuard.js";
import type { AgentStopReason, RunBudgetKey } from "./RunPolicyTypes.js";

export interface AgentActivityTimelineSink {
  getRun(): { id: string } | null;
  startStep(input: {
    runId: string;
    type: "summary";
    title: string;
    content?: string;
  }): { id: string };
  completeStep(stepId: string, result?: string): void;
  completeRun(summary: string): void;
  partialCompleteRun?(summary: string, title?: string): void;
  failRun(error: string): void;
  cancelRun(reason?: string): void;
}

export interface FinalizeAgentActivityTimelineInput {
  timeline?: AgentActivityTimelineSink;
  runId?: string;
  answer: string;
  reachedLimit: boolean;
  budgetExhausted?: RunBudgetKey;
  stopReason?: AgentStopReason;
  completionGuard?: Pick<CompletionGuardResult, "status" | "reason">;
  partialSummary?: string;
  budgetLedger?: BudgetLedgerSnapshot;
  maxRecoveryTurns: number;
}

export function finalizeAgentActivityTimeline(input: FinalizeAgentActivityTimelineInput): void {
  const tl = input.timeline;
  if (!tl) return;
  const runId = input.runId ?? tl.getRun()?.id ?? "";
  const stop = input.stopReason ?? (input.reachedLimit ? "budget_exhausted" : "completed");

  if (stop === "user_cancelled") {
    tl.cancelRun("用户取消");
    return;
  }

  if (isPartialTimelineStop(stop, input.completionGuard?.status)) {
    const title =
      stop === "misleading_completion"
        ? "检测到虚假完成"
        : stop === "recovery_partial"
          ? "部分完成 · 恢复预算耗尽"
          : "任务未完全完成";
    const summary =
      input.partialSummary ||
      input.completionGuard?.reason ||
      input.stopReason ||
      "";
    partialCompleteOrFail(tl, summary, title);
    return;
  }

  if (stop === "awaiting_permission") {
    const summary = input.partialSummary || input.completionGuard?.reason || "等待工具授权";
    partialCompleteOrFail(tl, summary, "等待工具授权");
    return;
  }

  if (stop === "completed" && !input.reachedLimit) {
    const summary = tl.startStep({
      runId,
      type: "summary",
      title: "任务完成",
      content: input.answer.slice(0, 400),
    });
    tl.completeStep(summary.id, input.answer.slice(0, 500));
    tl.completeRun(input.answer.slice(0, 800));
    return;
  }

  if (input.reachedLimit) {
    const ledger = input.budgetLedger ?? {
      preflightTools: 0,
      recoveryTurns: 0,
      cachedToolHits: 0,
    };
    const summary =
      input.partialSummary ||
      `运行预算耗尽：${input.budgetExhausted ?? "unknown"}（恢复 ${ledger.recoveryTurns}/${input.maxRecoveryTurns}）`;
    partialCompleteOrFail(tl, summary, "部分完成 · 预算耗尽");
    return;
  }

  tl.completeRun(input.answer.slice(0, 800));
}

function isPartialTimelineStop(
  stop: AgentStopReason,
  guardStatus?: CompletionGuardResult["status"],
): boolean {
  return (
    stop === "completed_partial" ||
    stop === "recovery_partial" ||
    stop === "misleading_completion" ||
    stop === "blocked_by_policy" ||
    guardStatus === "historical_reference" ||
    guardStatus === "completed_partial" ||
    guardStatus === "misleading_completion" ||
    guardStatus === "blocked_by_policy"
  );
}

function partialCompleteOrFail(
  tl: AgentActivityTimelineSink,
  summary: string,
  title: string,
): void {
  if (typeof tl.partialCompleteRun === "function") {
    tl.partialCompleteRun(summary.slice(0, 800), title);
    return;
  }
  tl.failRun(title);
}
