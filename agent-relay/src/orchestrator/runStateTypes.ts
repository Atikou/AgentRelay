import { shouldRunPlanWorkflow } from "../agent/PlanWorkflow.js";
import type {
  AgentExecutionMeta,
  AgentRunMode,
  AgentStopReason,
  RunBudgetKey,
  RunBudgetUsage,
} from "../agent/RunPolicy.js";
import type { AgentToolStep } from "../agent/toolStep.js";
import {
  PLAN_WORKFLOW_STEP_IDS,
  type PlanWorkflowStepId,
} from "./planWorkflowConstants.js";
import {
  extractLocationContextFromSteps,
  type RunStateLocationContext,
  type RunStateSearchPlan,
} from "./runStateLocation.js";

export type { PlanWorkflowStepId } from "./planWorkflowConstants.js";
export { PLAN_WORKFLOW_STEP_IDS } from "./planWorkflowConstants.js";
export type { RunStateLocationContext, RunStateSearchPlan } from "./runStateLocation.js";
export { extractLocationContextFromSteps } from "./runStateLocation.js";

export type RunStateStatus = "resumable" | "completed";

export interface RunStateToolRef {
  tool: string;
  iteration: number;
  toolCallId?: string;
}

export interface RunState {
  runId: string;
  mode: AgentRunMode;
  goal: string;
  sessionId?: string;
  taskId?: string;
  status: RunStateStatus;
  completedSteps: PlanWorkflowStepId[];
  pendingSteps: PlanWorkflowStepId[];
  scannedPaths: string[];
  readFiles: string[];
  toolResultRefs: RunStateToolRef[];
  completedToolSteps: AgentToolStep[];
  budgetUsage: RunBudgetUsage;
  stopReason: AgentStopReason;
  budgetExhausted?: RunBudgetKey;
  updatedAt: string;
  /** 定位进度：searchPlan / visitedFiles / candidateFiles 等，续跑时注入 locate。 */
  location?: RunStateLocationContext;
}

export function extractCompletedWorkflowSteps(steps: AgentToolStep[]): PlanWorkflowStepId[] {
  const done = new Set<PlanWorkflowStepId>();
  for (const step of steps) {
    if (!step.ok) continue;
    if ((PLAN_WORKFLOW_STEP_IDS as readonly string[]).includes(step.tool)) {
      done.add(step.tool as PlanWorkflowStepId);
    }
  }
  return PLAN_WORKFLOW_STEP_IDS.filter((id) => done.has(id));
}

export function buildPendingWorkflowSteps(completed: PlanWorkflowStepId[]): PlanWorkflowStepId[] {
  return PLAN_WORKFLOW_STEP_IDS.filter((id) => !completed.includes(id));
}

function readPathItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string") {
        return (item as { path: string }).path;
      }
      return undefined;
    })
    .filter((item): item is string => Boolean(item));
}

export function collectScannedPaths(steps: AgentToolStep[]): string[] {
  const paths = new Set<string>();
  for (const step of steps) {
    if (!step.ok || step.tool !== "project_scan") continue;
    const output = step.output as Record<string, unknown> | undefined;
    if (!output) continue;
    for (const item of readPathItems(output.sourceRoots)) paths.add(item);
    for (const item of readPathItems(output.importantDirs)) paths.add(item);
    for (const item of readPathItems(output.scannedPaths)) paths.add(item);
  }
  return [...paths].slice(0, 50);
}

export function collectReadFiles(steps: AgentToolStep[]): string[] {
  const files = new Set<string>();
  for (const step of steps) {
    if (!step.ok) continue;
    if (step.tool === "read_file") {
      const path = (step.input as { path?: unknown }).path;
      if (typeof path === "string") files.add(path);
    }
    if (step.tool === "context_pack") {
      const output = step.output as Record<string, unknown> | undefined;
      for (const item of readPathItems(output?.files)) files.add(item);
      for (const item of readPathItems(output?.packedFiles)) files.add(item);
    }
    if (step.tool === "locate_relevant_files") {
      const output = step.output as Record<string, unknown> | undefined;
      for (const item of readPathItems(output?.primaryFiles)) files.add(item);
      for (const item of readPathItems(output?.candidateFiles)) files.add(item);
    }
  }
  return [...files].slice(0, 50);
}

export function buildToolResultRefs(steps: AgentToolStep[]): RunStateToolRef[] {
  return steps.map((step) => ({
    tool: step.tool,
    iteration: step.iteration,
    toolCallId: step.toolCallId,
  }));
}

/** 预算耗尽且仍有 PlanWorkflow 待执行步骤时生成可续跑状态。 */
export function buildRunStateFromAgentRun(input: {
  runId: string;
  goal: string;
  mode: AgentRunMode;
  sessionId?: string;
  taskId?: string;
  steps: AgentToolStep[];
  executionMeta: AgentExecutionMeta;
  projectIndexStats?: { fileCount: number; symbolCount: number };
}): RunState | null {
  if (input.executionMeta.stopReason !== "budget_exhausted") return null;
  if (!shouldRunPlanWorkflow(input.goal, input.mode)) return null;

  const completedSteps = extractCompletedWorkflowSteps(input.steps);
  const pendingSteps = buildPendingWorkflowSteps(completedSteps);
  if (pendingSteps.length === 0) return null;

  const now = new Date().toISOString();
  const location = extractLocationContextFromSteps(input.steps, {
    projectIndexFileCount: input.projectIndexStats?.fileCount,
    projectIndexSymbolCount: input.projectIndexStats?.symbolCount,
  });
  return {
    runId: input.runId,
    mode: input.mode,
    goal: input.goal,
    sessionId: input.sessionId,
    taskId: input.taskId,
    status: "resumable",
    completedSteps,
    pendingSteps,
    scannedPaths: collectScannedPaths(input.steps),
    readFiles: collectReadFiles(input.steps),
    toolResultRefs: buildToolResultRefs(input.steps),
    completedToolSteps: input.steps,
    budgetUsage: input.executionMeta.usage,
    stopReason: input.executionMeta.stopReason,
    budgetExhausted: input.executionMeta.budgetExhausted,
    updatedAt: now,
    location,
  };
}
