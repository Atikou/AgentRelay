import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { Cron } from "croner";

import type { BackgroundTaskRecord } from "../background/types.js";
import type { NotificationQueue } from "../background/NotificationQueue.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import { FileWatchHub, matchFilePattern, type FileWatchEvent } from "./FileWatchHub.js";
import { GitStatusHub, type GitStatusSnapshot } from "./GitStatusHub.js";
import type { CronMissPolicy } from "./types.js";
import {
  CreateTriggerInputSchema,
  type CreateTriggerInput,
  type MissPolicy,
  type TriggerJournalLine,
  type TriggerRecord,
  TriggerRecordSchema,
} from "./types.js";

type TimerHandle = { stop: () => void };

export interface TriggerFireContext {
  triggerId: string;
  goal: string;
  unattended: boolean;
  sessionId?: string;
}

export interface SchedulerOptions {
  workspaceRoot?: string;
  unattendedGoalPatterns?: string[];
  gitPollIntervalMs?: number;
  defaultCronMissPolicy?: CronMissPolicy;
  /** 触发后回调：由 Orchestrator 创建 Run / 无人值守时自动执行。 */
  onFire?: (ctx: TriggerFireContext) => { runId?: string } | void;
}

interface FireContext {
  filePath?: string;
  fileEvent?: FileWatchEvent["kind"];
  gitBranch?: string;
  gitDirty?: boolean;
}

/**
 * 触发器调度器（M8）。
 * 触发后仅向通知队列写入待办描述，不绕过权限直接执行工具。
 */
export class Scheduler {
  private readonly triggers = new Map<string, TriggerRecord>();
  private readonly timers = new Map<string, TimerHandle>();
  private readonly watchUnsubs = new Map<string, () => void>();
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly firing = new Set<string>();
  private readonly fileWatchHub?: FileWatchHub;
  private readonly workspaceRoot?: string;
  private readonly unattendedGoalPatterns: string[];
  private readonly gitPollIntervalMs: number;
  private readonly defaultCronMissPolicy: CronMissPolicy;
  private gitHub?: GitStatusHub;
  private readonly lastFireKeys = new Map<string, string>();
  private onFire?: (ctx: TriggerFireContext) => { runId?: string } | void;
  private started = false;

  constructor(
    private readonly journalFile: string,
    private readonly notifications: NotificationQueue,
    private readonly trace?: TraceLogger,
    options?: SchedulerOptions,
  ) {
    mkdirSync(path.dirname(journalFile), { recursive: true });
    this.workspaceRoot = options?.workspaceRoot;
    this.unattendedGoalPatterns = options?.unattendedGoalPatterns ?? [];
    this.gitPollIntervalMs = options?.gitPollIntervalMs ?? 5000;
    this.defaultCronMissPolicy = options?.defaultCronMissPolicy ?? "skip";
    this.onFire = options?.onFire;
    if (options?.workspaceRoot) {
      this.fileWatchHub = new FileWatchHub(options.workspaceRoot);
    }
    this.replay();
  }

  setFireHandler(fn: (ctx: TriggerFireContext) => { runId?: string } | void): void {
    this.onFire = fn;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const trigger of this.triggers.values()) {
      if (trigger.status === "active") {
        this.arm(trigger);
      }
    }
    this.refreshGitPolling();
  }

  stop(): void {
    this.started = false;
    for (const handle of this.timers.values()) {
      handle.stop();
    }
    this.timers.clear();
    for (const unsub of this.watchUnsubs.values()) {
      unsub();
    }
    this.watchUnsubs.clear();
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.fileWatchHub?.closeAll();
    this.gitHub?.stop();
  }

  list(): TriggerRecord[] {
    return [...this.triggers.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): TriggerRecord | undefined {
    const t = this.triggers.get(id);
    return t ? { ...t } : undefined;
  }

  register(raw: CreateTriggerInput): TriggerRecord {
    const parsed = CreateTriggerInputSchema.parse(raw);
    const now = new Date().toISOString();
    const eventFilter =
      parsed.kind === "event" && parsed.eventType === "file_changed"
        ? { watchPath: ".", ...parsed.eventFilter }
        : parsed.eventFilter;
    const trigger: TriggerRecord = {
      id: randomUUID(),
      name: parsed.name,
      kind: parsed.kind,
      status: "active",
      goal: parsed.goal,
      createdAt: now,
      updatedAt: now,
      fireCount: 0,
      at: parsed.at,
      intervalMs: parsed.intervalMs,
      cron: parsed.cron,
      timezone: parsed.timezone,
      eventType: parsed.eventType,
      eventFilter,
      missPolicy: parsed.missPolicy ?? "skip",
      cronMissPolicy: parsed.cronMissPolicy,
    };
    this.triggers.set(trigger.id, trigger);
    this.persist(trigger);
    if (this.started) {
      this.arm(trigger);
      this.refreshGitPolling();
    }
    this.trace?.write({ type: "scheduler_register", triggerId: trigger.id, kind: trigger.kind });
    return { ...trigger };
  }

  pause(id: string): TriggerRecord | undefined {
    const trigger = this.triggers.get(id);
    if (!trigger || trigger.status === "cancelled" || trigger.status === "completed") {
      return trigger ? { ...trigger } : undefined;
    }
    trigger.status = "paused";
    trigger.updatedAt = new Date().toISOString();
    this.disarm(id);
    this.persist(trigger);
    this.refreshGitPolling();
    return { ...trigger };
  }

  resume(id: string): TriggerRecord | undefined {
    const trigger = this.triggers.get(id);
    if (!trigger || trigger.status === "cancelled" || trigger.status === "completed") {
      return trigger ? { ...trigger } : undefined;
    }
    trigger.status = "active";
    trigger.updatedAt = new Date().toISOString();
    this.persist(trigger);
    if (this.started) {
      this.arm(trigger);
      this.refreshGitPolling();
    }
    return { ...trigger };
  }

  cancel(id: string): TriggerRecord | undefined {
    const trigger = this.triggers.get(id);
    if (!trigger) return undefined;
    trigger.status = "cancelled";
    trigger.updatedAt = new Date().toISOString();
    this.disarm(id);
    this.persist(trigger);
    this.appendJournal({ op: "delete", id, time: trigger.updatedAt });
    return { ...trigger };
  }

  /** M8：后台任务完成时匹配 event 触发器。 */
  handleBackgroundCompleted(record: BackgroundTaskRecord): void {
    for (const trigger of this.triggers.values()) {
      if (trigger.status !== "active" || trigger.kind !== "event") continue;
      if (trigger.eventType !== "background_completed") continue;
      const wantStatus = trigger.eventFilter?.status;
      if (wantStatus && wantStatus !== record.status) continue;
      this.fire(trigger);
    }
  }

  /** M8：Git 状态变化时匹配 git_changed 触发器。 */
  handleGitChanged(snap: GitStatusSnapshot): void {
    for (const trigger of this.triggers.values()) {
      if (trigger.status !== "active" || trigger.kind !== "event") continue;
      if (trigger.eventType !== "git_changed") continue;
      if (trigger.eventFilter?.dirtyOnly && !snap.dirty) continue;
      if (trigger.eventFilter?.branch && trigger.eventFilter.branch !== snap.branch) continue;
      this.fire(trigger, { gitBranch: snap.branch, gitDirty: snap.dirty });
    }
  }

  /** M8：文件变更时匹配 file_changed 触发器（也可用于单测）。 */
  handleFileChanged(event: FileWatchEvent): void {
    for (const trigger of this.triggers.values()) {
      if (trigger.status !== "active" || trigger.kind !== "event") continue;
      if (trigger.eventType !== "file_changed") continue;
      const watchPath = (trigger.eventFilter?.watchPath ?? ".").replace(/\\/g, "/");
      const rel = event.relativePath.replace(/\\/g, "/");
      if (!pathMatchesWatch(rel, watchPath)) continue;
      if (!matchFilePattern(rel, trigger.eventFilter?.pattern)) continue;
      const debounceMs = trigger.eventFilter?.debounceMs ?? 300;
      this.scheduleDebouncedFire(trigger.id, debounceMs, {
        filePath: rel,
        fileEvent: event.kind,
      });
    }
  }

  private arm(trigger: TriggerRecord): void {
    this.disarm(trigger.id);
    if (trigger.kind === "event") {
      if (trigger.eventType === "file_changed") {
        this.armFileWatch(trigger);
      }
      if (trigger.eventType === "git_changed") {
        this.refreshGitPolling();
      }
      return;
    }

    if (trigger.kind === "once") {
      this.armOnce(trigger);
      return;
    }
    if (trigger.kind === "interval") {
      this.armInterval(trigger);
      return;
    }
    if (trigger.kind === "cron") {
      this.armCron(trigger);
    }
  }

  private armFileWatch(trigger: TriggerRecord): void {
    if (!this.fileWatchHub) return;
    const watchPath = trigger.eventFilter?.watchPath ?? ".";
    const pattern = trigger.eventFilter?.pattern;
    const debounceMs = trigger.eventFilter?.debounceMs ?? 300;
    const unsub = this.fileWatchHub.subscribe(watchPath, (event) => {
      const rel = event.relativePath.replace(/\\/g, "/");
      if (!pathMatchesWatch(rel, watchPath)) return;
      if (!matchFilePattern(rel, pattern)) return;
      this.scheduleDebouncedFire(trigger.id, debounceMs, {
        filePath: rel,
        fileEvent: event.kind,
      });
    });
    this.watchUnsubs.set(trigger.id, unsub);
  }

  private scheduleDebouncedFire(triggerId: string, debounceMs: number, ctx: FireContext): void {
    const existing = this.debounceTimers.get(triggerId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(triggerId);
      const trigger = this.triggers.get(triggerId);
      if (trigger) this.fire(trigger, ctx);
    }, debounceMs);
    this.debounceTimers.set(triggerId, timer);
  }

  private armOnce(trigger: TriggerRecord): void {
    const atMs = Date.parse(trigger.at ?? "");
    if (!Number.isFinite(atMs)) return;
    const delay = atMs - Date.now();
    if (delay <= 0) {
      this.handleMissedOnce(trigger);
      return;
    }
    const timer = setTimeout(() => {
      this.fire(trigger);
    }, delay);
    this.timers.set(trigger.id, {
      stop: () => clearTimeout(timer),
    });
  }

  private handleMissedOnce(trigger: TriggerRecord): void {
    const policy: MissPolicy = trigger.missPolicy ?? "skip";
    if (policy === "run_once") {
      this.fire(trigger);
      return;
    }
    trigger.status = "completed";
    trigger.updatedAt = new Date().toISOString();
    this.persist(trigger);
  }

  private armInterval(trigger: TriggerRecord): void {
    const ms = trigger.intervalMs ?? 0;
    if (ms <= 0) return;
    const timer = setInterval(() => {
      this.fire(trigger);
    }, ms);
    this.timers.set(trigger.id, {
      stop: () => clearInterval(timer),
    });
  }

  private armCron(trigger: TriggerRecord): void {
    const expr = trigger.cron ?? "";
    if (!expr) return;
    const job = new Cron(expr, { timezone: trigger.timezone, protect: true }, () => {
      this.fire(trigger);
    });
    this.timers.set(trigger.id, {
      stop: () => job.stop(),
    });
    const miss = trigger.cronMissPolicy ?? this.defaultCronMissPolicy;
    if (miss === "run_once" && trigger.fireCount === 0) {
      setTimeout(() => this.fire(trigger), 0);
    }
  }

  private refreshGitPolling(): void {
    const needsGit = [...this.triggers.values()].some(
      (t) => t.status === "active" && t.kind === "event" && t.eventType === "git_changed",
    );
    if (!needsGit || !this.workspaceRoot) {
      this.gitHub?.stop();
      return;
    }
    if (!this.gitHub) this.gitHub = new GitStatusHub();
    this.gitHub.start(this.workspaceRoot, this.gitPollIntervalMs, (snap) => {
      this.handleGitChanged(snap);
    });
  }

  private isUnattended(goal: string): boolean {
    if (this.unattendedGoalPatterns.length === 0) return false;
    return this.unattendedGoalPatterns.some((p) => p === "*" || goal.includes(p));
  }

  private fire(trigger: TriggerRecord, ctx?: FireContext): void {
    if (trigger.status !== "active") return;
    if (this.firing.has(trigger.id)) return;

    const dedupeKey = `${ctx?.filePath ?? ""}|${ctx?.gitBranch ?? ""}|${String(ctx?.gitDirty ?? "")}`;
    if (dedupeKey !== "||" && this.lastFireKeys.get(trigger.id) === dedupeKey && trigger.lastFiredAt) {
      const since = Date.now() - Date.parse(trigger.lastFiredAt);
      if (since < 1500) return;
    }
    if (dedupeKey !== "||") this.lastFireKeys.set(trigger.id, dedupeKey);

    const minGapMs =
      trigger.kind === "interval" && trigger.intervalMs ? Math.floor(trigger.intervalMs * 0.5) : 0;
    if (minGapMs > 0 && trigger.lastFiredAt) {
      const since = Date.now() - Date.parse(trigger.lastFiredAt);
      if (since < minGapMs) return;
    }

    this.firing.add(trigger.id);
    try {
      const now = new Date().toISOString();
      trigger.lastFiredAt = now;
      trigger.fireCount += 1;
      trigger.updatedAt = now;

      const fileHint = ctx?.filePath ? `（文件 ${ctx.filePath}）` : "";
      const gitHint =
        ctx?.gitBranch !== undefined
          ? `（分支 ${ctx.gitBranch}${ctx.gitDirty ? " 有未提交变更" : ""}）`
          : "";
      const unattended = this.isUnattended(trigger.goal);
      const fired = this.onFire?.({
        triggerId: trigger.id,
        goal: trigger.goal,
        unattended,
      });
      const runId = fired?.runId;
      this.notifications.enqueue({
        source: "scheduler",
        level: "info",
        priority: unattended ? "normal" : "high",
        runId,
        dedupeKey:
          dedupeKey !== "||"
            ? `scheduler:${trigger.id}:${dedupeKey}`
            : `scheduler:${trigger.id}:${trigger.fireCount}`,
        mergeKey: `scheduler:${trigger.id}`,
        message: `定时触发「${trigger.name}」：${trigger.goal}${fileHint}${gitHint}`,
        payload: {
          runId,
          triggerId: trigger.id,
          kind: trigger.kind,
          eventType: trigger.eventType,
          goal: trigger.goal,
          requiresConfirmation: !unattended,
          unattended,
          filePath: ctx?.filePath,
          fileEvent: ctx?.fileEvent,
          gitBranch: ctx?.gitBranch,
          gitDirty: ctx?.gitDirty,
        },
      });
      this.trace?.write({
        type: "scheduler_fire",
        triggerId: trigger.id,
        kind: trigger.kind,
        goal: trigger.goal,
        filePath: ctx?.filePath,
        unattended,
      });

      if (trigger.kind === "once") {
        trigger.status = "completed";
        this.disarm(trigger.id);
      }
      this.persist(trigger);
    } finally {
      this.firing.delete(trigger.id);
    }
  }

  private disarm(id: string): void {
    const handle = this.timers.get(id);
    if (handle) {
      handle.stop();
      this.timers.delete(id);
    }
    const unsub = this.watchUnsubs.get(id);
    if (unsub) {
      unsub();
      this.watchUnsubs.delete(id);
    }
    const debounce = this.debounceTimers.get(id);
    if (debounce) {
      clearTimeout(debounce);
      this.debounceTimers.delete(id);
    }
  }

  private persist(trigger: TriggerRecord): void {
    TriggerRecordSchema.parse(trigger);
    this.triggers.set(trigger.id, trigger);
    this.appendJournal({ op: "upsert", time: trigger.updatedAt, trigger: { ...trigger } });
  }

  private appendJournal(line: TriggerJournalLine): void {
    appendFileSync(this.journalFile, `${JSON.stringify(line)}\n`, "utf-8");
  }

  private replay(): void {
    if (!existsSync(this.journalFile)) return;
    const text = readFileSync(this.journalFile, "utf-8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: TriggerJournalLine;
      try {
        parsed = JSON.parse(trimmed) as TriggerJournalLine;
      } catch {
        continue;
      }
      if (parsed.op === "delete") {
        this.triggers.delete(parsed.id);
        continue;
      }
      if (parsed.op === "upsert") {
        this.triggers.set(parsed.trigger.id, parsed.trigger);
      }
    }
  }
}

function pathMatchesWatch(relativePath: string, watchPath: string): boolean {
  const normWatch = watchPath.replace(/\\/g, "/").replace(/\/$/, "") || ".";
  if (normWatch === ".") return true;
  return relativePath === normWatch || relativePath.startsWith(`${normWatch}/`);
}
