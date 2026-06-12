import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import { resolveInsideWorkspace } from "../tools/pathSafe.js";
import { assertBackgroundCommandAllowed, type ShellPolicy } from "../policy/ShellPolicy.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { NotificationQueue } from "./NotificationQueue.js";
import {
  evaluateOutputRules,
  matchRuleOnStream,
  shouldTriggerOnMatch,
  type OutputMatchResult,
} from "./outputMatcher.js";
import type { BackgroundStartOptions, BackgroundTaskRecord } from "./types.js";

export interface BackgroundTriggerNextInput {
  record: BackgroundTaskRecord;
  matches: OutputMatchResult[];
  goal: string;
  phase: "stream" | "complete";
}

const MAX_OUTPUT_BYTES = 512 * 1024;

/** 在后台启动长时间命令，记录输出，完成后写入通知队列。 */
export class BackgroundTaskManager {
  private readonly tasks = new Map<string, BackgroundTaskRecord>();
  private readonly processes = new Map<string, ChildProcess>();
  private readonly cancelling = new Set<string>();
  private readonly timingOut = new Set<string>();
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly streamFiredRules = new Map<string, Set<string>>();
  private readonly streamTriggeredGoals = new Set<string>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly notifications: NotificationQueue,
    private readonly trace?: TraceLogger,
    private readonly onTaskDone?: (record: BackgroundTaskRecord) => void,
    private readonly onTriggerNext?: (input: BackgroundTriggerNextInput) => void,
    private readonly shellPolicy?: ShellPolicy,
  ) {}

  start(command: string, options?: BackgroundStartOptions): BackgroundTaskRecord {
    const trimmed = command.trim();
    if (!trimmed) throw new Error("command 不能为空");

    if (this.shellPolicy) {
      this.shellPolicy.assertAllowed(trimmed, "后台命令被策略拒绝");
    } else {
      assertBackgroundCommandAllowed(trimmed);
    }

    const cwd = options?.cwd;
    const timeoutMs = options?.timeoutMs;
    const resolvedCwd = cwd ? resolveInsideWorkspace(this.workspaceRoot, cwd) : this.workspaceRoot;
    const id = randomUUID();
    const record: BackgroundTaskRecord = {
      id,
      command: trimmed,
      cwd: resolvedCwd,
      timeoutMs,
      status: "running",
      stdout: "",
      stderr: "",
      startedAt: new Date().toISOString(),
      outputRules: options?.outputRules,
      triggerOnMatch: options?.triggerOnMatch,
      outputMatches: [],
    };
    this.streamFiredRules.set(id, new Set());
    this.tasks.set(id, record);
    this.trace?.write({ type: "background_start", taskId: id, command: trimmed });

    const child = spawn(trimmed, [], {
      shell: true,
      cwd: resolvedCwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid) record.pid = child.pid;
    this.processes.set(id, child);

    child.stdout?.on("data", (chunk: Buffer) => {
      appendOutput(record, "stdout", chunk);
      this.checkStreamRules(record);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      appendOutput(record, "stderr", chunk);
      this.checkStreamRules(record);
    });

    if (timeoutMs != null) {
      this.scheduleTimeout(id, timeoutMs);
    }

    child.on("error", (err) => {
      this.clearTaskTimer(id);
      record.status = "failed";
      record.error = String(err);
      record.endedAt = new Date().toISOString();
      this.processes.delete(id);
      this.enqueueDone(record);
    });

    child.on("close", (code, signal) => {
      this.clearTaskTimer(id);
      this.processes.delete(id);
      record.endedAt = new Date().toISOString();
      record.exitCode = code;

      const wasTimeout = this.timingOut.delete(id);
      const wasCancelled = this.cancelling.delete(id);
      if (wasTimeout) {
        record.status = "timed_out";
        record.error = `执行超时（${timeoutMs ?? "?"}ms）`;
      } else if (wasCancelled || signal === "SIGTERM" || signal === "SIGKILL") {
        record.status = "cancelled";
      } else if (code === 0) {
        record.status = "completed";
      } else {
        record.status = "failed";
      }

      this.enqueueDone(record);
      this.trace?.write({
        type: "background_done",
        taskId: id,
        status: record.status,
        exitCode: code,
        signal,
      });
    });

    return this.snapshot(record);
  }

  get(id: string): BackgroundTaskRecord | undefined {
    const task = this.tasks.get(id);
    return task ? this.snapshot(task) : undefined;
  }

  list(): BackgroundTaskRecord[] {
    return [...this.tasks.values()].map((t) => this.snapshot(t));
  }

  markTriggeredRun(id: string, runId: string): void {
    const task = this.tasks.get(id);
    if (task) task.triggeredRunId = runId;
  }

  cancel(id: string): BackgroundTaskRecord | undefined {
    const task = this.tasks.get(id);
    const proc = this.processes.get(id);
    if (!task || !proc) return undefined;
    if (task.status !== "running") return this.snapshot(task);

    this.cancelling.add(id);
    this.clearTaskTimer(id);
    killProcessTree(proc);
    return this.snapshot(task);
  }

  private scheduleTimeout(id: string, timeoutMs: number): void {
    const timer = setTimeout(() => {
      this.timeouts.delete(id);
      const task = this.tasks.get(id);
      const proc = this.processes.get(id);
      if (!task || !proc || task.status !== "running") return;
      this.timingOut.add(id);
      killProcessTree(proc);
    }, timeoutMs);
    this.timeouts.set(id, timer);
  }

  private clearTaskTimer(id: string): void {
    const timer = this.timeouts.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.timeouts.delete(id);
  }

  private enqueueDone(record: BackgroundTaskRecord): void {
    const rules = record.outputRules ?? [];
    if (rules.length > 0) {
      const evaluated = evaluateOutputRules(record, rules);
      const prior = record.outputMatches ?? [];
      const merged = mergeMatchResults(prior, evaluated);
      record.outputMatches = merged;
    }

    const trigger = record.triggerOnMatch;
    if (
      trigger &&
      rules.length > 0 &&
      record.outputMatches &&
      shouldTriggerOnMatch(record, rules, record.outputMatches, trigger)
    ) {
      this.fireTriggerNext(record, record.outputMatches, trigger.goal, "complete");
    }

    const level =
      record.status === "completed"
        ? "info"
        : record.status === "cancelled" || record.status === "timed_out"
          ? "warn"
          : "error";
    const matchedNames = (record.outputMatches ?? []).filter((m) => m.matched).map((m) => m.name);
    this.notifications.enqueue({
      source: "background_task",
      level,
      message: `后台任务「${record.command}」已${statusLabel(record.status)}（退出码 ${record.exitCode ?? "—"}）`,
      taskId: record.id,
      payload: {
        command: record.command,
        status: record.status,
        exitCode: record.exitCode,
        stdoutTail: tail(record.stdout),
        stderrTail: tail(record.stderr),
        outputMatches: record.outputMatches,
        matchedRules: matchedNames,
        triggeredRunId: record.triggeredRunId,
      },
    });
    this.streamFiredRules.delete(record.id);
    this.onTaskDone?.(record);
  }

  private checkStreamRules(record: BackgroundTaskRecord): void {
    const rules = record.outputRules ?? [];
    if (rules.length === 0) return;
    const fired = this.streamFiredRules.get(record.id) ?? new Set<string>();
    for (const rule of rules) {
      if (!rule.fireOnStream || fired.has(rule.name)) continue;
      const hit = matchRuleOnStream(record, rule);
      if (!hit) continue;
      fired.add(rule.name);
      record.outputMatches = mergeMatchResults(record.outputMatches ?? [], [hit]);
      this.notifications.enqueue({
        source: "background_task",
        level: "info",
        message: `后台任务「${record.command}」输出命中规则：${rule.name}`,
        taskId: record.id,
        dedupeKey: `bg-stream:${record.id}:${rule.name}`,
        payload: {
          command: record.command,
          outputMatch: hit,
          phase: "stream",
        },
      });
      const trigger = record.triggerOnMatch;
      if (trigger?.goal && trigger.requireSuccess === false) {
        this.fireTriggerNext(record, [hit], trigger.goal, "stream");
      }
    }
    this.streamFiredRules.set(record.id, fired);
  }

  private fireTriggerNext(
    record: BackgroundTaskRecord,
    matches: OutputMatchResult[],
    goal: string,
    phase: BackgroundTriggerNextInput["phase"],
  ): void {
    if (record.triggeredRunId) return;
    const key = `${record.id}:${goal}`;
    if (phase === "stream" && this.streamTriggeredGoals.has(key)) return;
    if (phase === "stream") this.streamTriggeredGoals.add(key);
    this.onTriggerNext?.({ record, matches, goal, phase });
    this.trace?.write({
      type: "background_trigger_next",
      taskId: record.id,
      goal,
      phase,
      matches: matches.filter((m) => m.matched).map((m) => m.name),
    });
  }

  private snapshot(task: BackgroundTaskRecord): BackgroundTaskRecord {
    return { ...task };
  }
}

function appendOutput(task: BackgroundTaskRecord, stream: "stdout" | "stderr", chunk: Buffer): void {
  const text = chunk.toString("utf-8");
  const current = stream === "stdout" ? task.stdout : task.stderr;
  const next = current + text;
  const trimmed = next.length > MAX_OUTPUT_BYTES ? next.slice(-MAX_OUTPUT_BYTES) : next;
  if (stream === "stdout") task.stdout = trimmed;
  else task.stderr = trimmed;
}

function mergeMatchResults(
  prior: OutputMatchResult[],
  next: OutputMatchResult[],
): OutputMatchResult[] {
  const byName = new Map(prior.map((p) => [p.name, p]));
  for (const item of next) {
    const existing = byName.get(item.name);
    byName.set(item.name, existing ? { ...existing, ...item, matched: existing.matched || item.matched } : item);
  }
  return [...byName.values()];
}

function tail(text: string, max = 500): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

/** Windows 上 shell 子进程需 taskkill /T /F 才能可靠终止。 */
function killProcessTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (!pid) {
    proc.kill();
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  proc.kill("SIGTERM");
}

function statusLabel(status: BackgroundTaskRecord["status"]): string {
  switch (status) {
    case "completed":
      return "完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "取消";
    case "timed_out":
      return "超时";
    default:
      return "结束";
  }
}
