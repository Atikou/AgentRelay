import type { ModelTaskType } from "../model/taskType.js";
import type { ToolPermission } from "./permissions.js";
import { defaultRunPolicyManager } from "./RunPolicyManager.js";

export type AgentRunMode = "chat" | "plan" | "implement" | "debug" | "review";

export type AgentStopReason = "completed" | "budget_exhausted" | "error" | "user_cancelled";

export interface RunBudget {
  maxModelTurns: number;
  maxToolCalls: number;
  maxReadCalls: number;
  maxWriteCalls: number;
  maxShellCalls: number;
  maxRuntimeMs: number;
}

export interface RunBudgetUsage {
  modelTurns: number;
  toolCalls: number;
  readCalls: number;
  writeCalls: number;
  shellCalls: number;
  runtimeMs: number;
}

export type RunBudgetKey = keyof RunBudget;

export interface LocationExecutionMeta {
  usedLocateSteps: number;
  usedSearchCalls: number;
  usedListCalls: number;
  usedReadForLocationCalls: number;
  locatedFiles: string[];
  candidateFiles: string[];
  stopReason?: string;
  needsContinue: boolean;
  confidence?: number;
}

export interface AgentExecutionMeta {
  mode: AgentRunMode;
  budget: RunBudget;
  usage: RunBudgetUsage;
  budgetExhausted?: RunBudgetKey;
  location?: LocationExecutionMeta;
  usedIterations: number;
  usedModelTurns: number;
  usedToolCalls: number;
  usedReadCalls: number;
  usedWriteCalls: number;
  usedShellCalls: number;
  stopReason: AgentStopReason;
  needsMoreBudget: boolean;
  suggestedBudget?: RunBudget;
}

export interface RunPolicy {
  mode: AgentRunMode;
  budget: RunBudget;
  allowedPermissions: ToolPermission[];
  requireFinalAnswer: boolean;
  allowPartialAnswer: boolean;
  suggestedBudget: RunBudget;
  systemHint: string;
}

export interface ResolveRunPolicyInput {
  requestedMode?: string;
  budget?: Partial<RunBudget>;
  taskType?: ModelTaskType;
  message?: string;
}

export function resolveRunPolicy(input: ResolveRunPolicyInput = {}): RunPolicy {
  return defaultRunPolicyManager.resolve(input);
}

export function parseRunMode(mode: string | undefined): AgentRunMode | undefined {
  return defaultRunPolicyManager.parseMode(mode);
}

export { RunPolicyManager, defaultRunPolicyManager } from "./RunPolicyManager.js";
