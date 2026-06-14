import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { CleanupJournalEntry } from "./types.js";
import { lifecycleDir } from "./policy.js";

export class CleanupJournal {
  private readonly journalFile: string;

  constructor(dataDir: string) {
    const dir = lifecycleDir(dataDir);
    mkdirSync(dir, { recursive: true });
    this.journalFile = path.join(dir, "cleanup-runs.jsonl");
  }

  append(entry: CleanupJournalEntry): void {
    appendFileSync(this.journalFile, `${JSON.stringify(entry)}\n`, "utf-8");
  }

  listRecent(limit = 50): CleanupJournalEntry[] {
    if (!existsSync(this.journalFile)) return [];
    const lines = readFileSync(this.journalFile, "utf-8").split("\n").filter(Boolean);
    const out: CleanupJournalEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      try {
        out.push(JSON.parse(lines[i]!) as CleanupJournalEntry);
      } catch {
        continue;
      }
    }
    return out;
  }
}

export function writeTombstone(dataDir: string, entry: {
  kind: "session_delete" | "session_purge" | "run_delete";
  sessionId?: string;
  runIds: string[];
  mode: "normal" | "purge";
}): void {
  const dir = lifecycleDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "tombstones.jsonl");
  const line = {
    id: randomUUID(),
    ...entry,
    deletedAt: Date.now(),
  };
  appendFileSync(file, `${JSON.stringify(line)}\n`, "utf-8");
}
