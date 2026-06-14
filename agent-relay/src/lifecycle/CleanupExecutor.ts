import { readFileSync } from "node:fs";

import { atomicWriteFile, fileAgeDays, safeDeleteDirectory, safeDeleteFile } from "./fsUtils.js";
import { CleanupJournal } from "./CleanupJournal.js";
import type { CleanupAction, CleanupApplyResult, LifecyclePolicy } from "./types.js";

export class CleanupExecutor {
  constructor(
    private readonly journal: CleanupJournal,
    private readonly policy: LifecyclePolicy,
  ) {}

  apply(actions: CleanupAction[], cleanupRunId: string, startedAt: number): CleanupApplyResult {
    const result: CleanupApplyResult = {
      cleanupRunId,
      mode: "apply",
      startedAt,
      endedAt: 0,
      applied: 0,
      skipped: 0,
      failed: 0,
      bytesFreed: 0,
      actions: [],
    };

    for (const action of actions) {
      const actionStarted = Date.now();
      if (!action.canDelete) {
        result.skipped += 1;
        result.actions.push({
          actionId: action.actionId,
          type: action.type,
          target: action.path,
          status: "skipped",
          bytesFreed: 0,
          error: action.blockedReason ?? "blocked",
        });
        this.journal.append({
          cleanupRunId,
          actionId: action.actionId,
          type: action.type,
          target: action.path,
          status: "skipped",
          bytesFreed: 0,
          startedAt: actionStarted,
          endedAt: Date.now(),
          error: action.blockedReason,
        });
        continue;
      }

      if (action.risk !== "low" && this.policy.cleanup.requireDryRunBeforeApply) {
        result.skipped += 1;
        result.actions.push({
          actionId: action.actionId,
          type: action.type,
          target: action.path,
          status: "skipped",
          bytesFreed: 0,
          error: "non-low risk requires explicit policy override",
        });
        continue;
      }

      try {
        const freed = this.executeOne(action);
        result.applied += 1;
        result.bytesFreed += freed;
        result.actions.push({
          actionId: action.actionId,
          type: action.type,
          target: action.path,
          status: "success",
          bytesFreed: freed,
        });
        this.journal.append({
          cleanupRunId,
          actionId: action.actionId,
          type: action.type,
          target: action.path,
          status: "success",
          bytesFreed: freed,
          startedAt: actionStarted,
          endedAt: Date.now(),
        });
      } catch (error) {
        result.failed += 1;
        const msg = String(error);
        result.actions.push({
          actionId: action.actionId,
          type: action.type,
          target: action.path,
          status: "failed",
          bytesFreed: 0,
          error: msg,
        });
        this.journal.append({
          cleanupRunId,
          actionId: action.actionId,
          type: action.type,
          target: action.path,
          status: "failed",
          bytesFreed: 0,
          startedAt: actionStarted,
          endedAt: Date.now(),
          error: msg,
        });
      }
    }

    result.endedAt = Date.now();
    return result;
  }

  private executeOne(action: CleanupAction): number {
    switch (action.type) {
      case "delete_file":
        safeDeleteFile(action.path);
        return action.bytes;
      case "delete_directory":
        safeDeleteDirectory(action.path);
        return action.bytes;
      case "compact_jsonl":
        return this.compactNotifications(action.path);
      default:
        throw new Error(`unsupported action type: ${action.type}`);
    }
  }

  private compactNotifications(filePath: string): number {
    const text = readFileSync(filePath, "utf-8");
    const lines = text.split("\n").filter(Boolean);
    const ttl = this.policy.retentionDays.readNotifications;
    const now = Date.now();
    const consumed = new Set<string>();

    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (parsed.op === "consume" && Array.isArray(parsed.ids)) {
        for (const id of parsed.ids) {
          if (typeof id === "string") consumed.add(id);
        }
      }
    }

    const kept: string[] = [];
    let removedBytes = 0;

    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        kept.push(line);
        continue;
      }
      if (parsed.op === "consume") {
        kept.push(line);
        continue;
      }
      const id = typeof parsed.id === "string" ? parsed.id : undefined;
      const ts = typeof parsed.timestamp === "string" ? parsed.timestamp : undefined;
      const isConsumed = parsed.consumed === true || (id != null && consumed.has(id));
      if (!isConsumed || !ts) {
        kept.push(line);
        continue;
      }
      const mtimeMs = Date.parse(ts);
      if (Number.isNaN(mtimeMs) || fileAgeDays(mtimeMs, now) < ttl) {
        kept.push(line);
        continue;
      }
      removedBytes += Buffer.byteLength(line, "utf-8") + 1;
    }

    atomicWriteFile(filePath, kept.length > 0 ? `${kept.join("\n")}\n` : "");
    return removedBytes;
  }
}
