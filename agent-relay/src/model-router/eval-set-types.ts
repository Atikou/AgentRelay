import type {
  ExecutionStrategy,
  ModelLevel,
  RouterInput,
  TaskType,
} from "./types.js";

export interface EvalSetCase {
  id: string;
  title: string;
  input: string;
  routerInput?: Partial<RouterInput>;
  expectedTaskType?: TaskType;
  expectedLevel?: ModelLevel;
  expectedStrategy?: ExecutionStrategy;
  tags?: string[];
}

export type EvalSetVerdict = "pass" | "fail" | "skipped";

export type EvalSetScope = "rule" | "smart";

export interface EvalSetCaseResult {
  caseId: string;
  caseTitle?: string;
  inputPreview?: string;
  verdict: EvalSetVerdict;
  expectedTaskType?: TaskType;
  actualTaskType?: TaskType;
  expectedLevel?: ModelLevel;
  actualLevel?: ModelLevel;
  expectedStrategy?: ExecutionStrategy;
  actualStrategy?: ExecutionStrategy;
  notes?: string[];
}

export interface EvalSetRunSummary {
  runId: string;
  setName: string;
  scope: EvalSetScope;
  startedAt: string;
  finishedAt: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  results: EvalSetCaseResult[];
}
