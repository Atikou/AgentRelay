import type { ToolPermission } from "../../core/permissions.js";
import type { AgentToolStep } from "../toolStep.js";
import { isSuccessfulToolStep } from "../toolStepOutcome.js";

export interface ToolLedgerEntry {
  toolName: string;
  permission?: ToolPermission;
  attempted: boolean;
  executed: boolean;
  blocked: boolean;
  blockReasonKind?: AgentToolStep["blockedReasonKind"];
  outcomeKind?: string;
  successful: boolean;
}

export interface ToolLedger {
  attemptedShellCalls: number;
  blockedShellCalls: number;
  successfulShellCalls: number;
  failedShellCalls: number;
  attemptedWriteCalls: number;
  blockedWriteCalls: number;
  successfulWriteCalls: number;
  failedWriteCalls: number;
  attemptedReadCalls: number;
  blockedReadCalls: number;
  successfulReadCalls: number;
  entries: ToolLedgerEntry[];
}

function permissionOf(step: AgentToolStep): ToolPermission | undefined {
  if (step.permission) return step.permission;
  if (step.tool === "shell_run") return "shell";
  if (step.tool === "write_file" || step.tool === "apply_patch") return "write";
  return "read";
}

function ledgerBucket(permission: ToolPermission | undefined): "shell" | "write" | "read" | undefined {
  if (permission === "shell" || permission === "network") return "shell";
  if (permission === "write" || permission === "dangerous") return "write";
  if (permission === "read") return "read";
  return undefined;
}

export function buildToolLedger(steps: AgentToolStep[]): ToolLedger {
  const ledger: ToolLedger = {
    attemptedShellCalls: 0,
    blockedShellCalls: 0,
    successfulShellCalls: 0,
    failedShellCalls: 0,
    attemptedWriteCalls: 0,
    blockedWriteCalls: 0,
    successfulWriteCalls: 0,
    failedWriteCalls: 0,
    attemptedReadCalls: 0,
    blockedReadCalls: 0,
    successfulReadCalls: 0,
    entries: [],
  };

  for (const step of steps) {
    const permission = permissionOf(step);
    const bucket = ledgerBucket(permission);
    const successful = isSuccessfulToolStep(step);
    const blocked = step.blocked === true;
    const executed = step.executed !== false && !blocked && successful;
    const failed = !blocked && !successful && step.executed !== false;

    ledger.entries.push({
      toolName: step.tool,
      permission,
      attempted: true,
      executed,
      blocked,
      blockReasonKind: step.blockedReasonKind,
      outcomeKind: step.outcomeKind,
      successful,
    });

    if (!bucket) continue;
    if (bucket === "shell") {
      ledger.attemptedShellCalls += 1;
      if (blocked) ledger.blockedShellCalls += 1;
      else if (successful) ledger.successfulShellCalls += 1;
      else if (failed) ledger.failedShellCalls += 1;
    } else if (bucket === "write") {
      ledger.attemptedWriteCalls += 1;
      if (blocked) ledger.blockedWriteCalls += 1;
      else if (successful) ledger.successfulWriteCalls += 1;
      else if (failed) ledger.failedWriteCalls += 1;
    } else {
      ledger.attemptedReadCalls += 1;
      if (blocked) ledger.blockedReadCalls += 1;
      else if (successful) ledger.successfulReadCalls += 1;
    }
  }

  return ledger;
}
