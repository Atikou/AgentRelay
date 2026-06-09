import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  AgentNotification,
  NotificationConsumeRecord,
  NotificationJournalLine,
  NotificationLevel,
  NotificationSource,
} from "./types.js";

/**
 * 线程安全（单进程）通知队列：内存态 + JSONL 持久化。
 * 主 Agent 仅在安全点调用 drain() 消费未读通知。
 */
export class NotificationQueue {
  private readonly items = new Map<string, AgentNotification>();
  private readonly consumed = new Set<string>();

  constructor(private readonly journalFile: string) {
    mkdirSync(path.dirname(journalFile), { recursive: true });
    this.replay();
  }

  enqueue(input: {
    source: NotificationSource;
    level: NotificationLevel;
    message: string;
    taskId?: string;
    payload?: Record<string, unknown>;
  }): AgentNotification {
    const notification: AgentNotification = {
      id: randomUUID(),
      consumed: false,
      timestamp: new Date().toISOString(),
      ...input,
    };
    this.items.set(notification.id, notification);
    this.append(notification);
    return notification;
  }

  /** 返回全部未消费通知并标记为已消费（安全点调用）。 */
  drain(): AgentNotification[] {
    const pending = [...this.items.values()].filter((n) => !this.consumed.has(n.id));
    if (pending.length === 0) return [];

    const ids = pending.map((n) => n.id);
    for (const id of ids) {
      this.consumed.add(id);
      const item = this.items.get(id);
      if (item) item.consumed = true;
    }

    const record: NotificationConsumeRecord = {
      op: "consume",
      ids,
      time: new Date().toISOString(),
    };
    this.append(record);
    return pending;
  }

  listPending(): AgentNotification[] {
    return [...this.items.values()].filter((n) => !this.consumed.has(n.id));
  }

  listAll(): AgentNotification[] {
    return [...this.items.values()];
  }

  private replay(): void {
    if (!existsSync(this.journalFile)) return;
    const text = readFileSync(this.journalFile, "utf-8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: NotificationJournalLine;
      try {
        parsed = JSON.parse(trimmed) as NotificationJournalLine;
      } catch {
        continue;
      }
      if ("op" in parsed && parsed.op === "consume") {
        for (const id of parsed.ids) {
          this.consumed.add(id);
          const item = this.items.get(id);
          if (item) item.consumed = true;
        }
        continue;
      }
      const n = parsed as AgentNotification;
      if (!n.id) continue;
      this.items.set(n.id, { ...n, consumed: this.consumed.has(n.id) });
    }
  }

  private append(line: NotificationJournalLine): void {
    appendFileSync(this.journalFile, `${JSON.stringify(line)}\n`, "utf-8");
  }
}
