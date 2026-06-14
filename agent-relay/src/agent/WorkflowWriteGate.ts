import type { AgentIntentType } from "./IntentTypes.js";
import { hasProjectScope, hasTargetHint } from "./WorkflowPlanner.js";
import type { AgentToolStep } from "./toolStep.js";

export const READ_WORKFLOW_TOOLS = new Set([
  "project_scan",
  "locate_relevant_files",
  "context_pack",
  "read_file",
  "list_files",
  "search_text",
  "symbol_search",
  "diff_file",
  "git_status",
  "git_diff",
]);

const WRITE_TOOLS = new Set(["write_file", "apply_patch"]);

export type WorkflowWriteGatePhase = "write" | "fix";

export interface WorkflowWriteGateInput {
  intent: AgentIntentType;
  goal: string;
  tool: string;
  steps: AgentToolStep[];
  hasProposal?: boolean;
  hasDebugAnalysis?: boolean;
}

export interface WorkflowWriteGateResult {
  blocked: boolean;
  phase?: WorkflowWriteGatePhase;
  reason?: string;
  readToolsBeforeWrite: number;
  priorWrites: number;
}

export function assessWorkflowWriteGate(input: WorkflowWriteGateInput): WorkflowWriteGateResult {
  const readToolsBeforeWrite = countSuccessfulReadTools(input.steps);
  const priorWrites = countSuccessfulWrites(input.steps);

  if (!WRITE_TOOLS.has(input.tool)) {
    return { blocked: false, readToolsBeforeWrite, priorWrites };
  }

  if (priorWrites > 0) {
    return {
      blocked: false,
      phase: input.intent === "debug" ? "fix" : "write",
      readToolsBeforeWrite,
      priorWrites,
    };
  }

  if (input.intent === "edit" || input.intent === "generate_file") {
    if (!input.hasProposal) {
      return {
        blocked: true,
        reason: "edit/generate-file workflow requires proposal phase before the first write-capable tool.",
        readToolsBeforeWrite,
        priorWrites,
      };
    }
    if (requiresReadBeforeWrite(input.intent, input.goal) && readToolsBeforeWrite === 0) {
      return {
        blocked: true,
        reason:
          "proposal phase is not complete: use read/locate tools to gather context before the first write-capable tool.",
        readToolsBeforeWrite,
        priorWrites,
      };
    }
    return {
      blocked: false,
      phase: "write",
      readToolsBeforeWrite,
      priorWrites,
    };
  }

  if (input.intent === "debug") {
    if (!input.hasDebugAnalysis) {
      return {
        blocked: true,
        reason: "debug workflow requires analysis phase before the first write-capable tool.",
        readToolsBeforeWrite,
        priorWrites,
      };
    }
    if (readToolsBeforeWrite === 0) {
      return {
        blocked: true,
        reason:
          "debug analysis is not complete: use read/locate tools to confirm root cause before the first write-capable tool.",
        readToolsBeforeWrite,
        priorWrites,
      };
    }
    return {
      blocked: false,
      phase: "fix",
      readToolsBeforeWrite,
      priorWrites,
    };
  }

  return { blocked: false, readToolsBeforeWrite, priorWrites };
}

export function requiresReadBeforeWrite(intent: AgentIntentType, goal: string): boolean {
  if (intent === "generate_file") {
    return hasProjectScope(goal);
  }
  if (intent === "edit" || intent === "debug") return true;
  return false;
}

export function countSuccessfulReadTools(steps: AgentToolStep[]): number {
  return steps.filter((step) => step.ok && READ_WORKFLOW_TOOLS.has(step.tool)).length;
}

export function countSuccessfulWrites(steps: AgentToolStep[]): number {
  return steps.filter(
    (step) => step.ok && (step.tool === "write_file" || step.tool === "apply_patch"),
  ).length;
}
