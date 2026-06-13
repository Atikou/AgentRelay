import type { TaskType } from "./types.js";

/** V7 预留：单条评测用例（不接入运行时）。 */
export interface EvalSetCase {
  id: string;
  title: string;
  input: string;
  /** 期望 RuleRouter 判定的任务类型（可选）。 */
  expectedTaskType?: TaskType;
  tags?: string[];
}

export type EvalSetVerdict = "pass" | "fail" | "skipped";

/** V7 预留：单条评测结果。 */
export interface EvalSetCaseResult {
  caseId: string;
  verdict: EvalSetVerdict;
  actualTaskType?: TaskType;
  notes?: string[];
}

/** V7 预留：批量评测汇总（写入 model_eval_results 表的未来落点）。 */
export interface EvalSetRunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  results: EvalSetCaseResult[];
}

/**
 * V7 扩展点：离线评测集执行器。
 * V6 仅提供类型与占位实现；全量自动评测不在当前阶段启用。
 */
export class EvalSetRunner {
  run(_cases: EvalSetCase[]): EvalSetRunSummary {
    throw new Error("EvalSetRunner 尚未启用（V7）；请先使用 RuntimeStats 采集与 /api/routing/stats 只读建议");
  }
}
