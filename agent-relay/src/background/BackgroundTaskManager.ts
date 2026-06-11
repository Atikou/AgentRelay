import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import { resolveInsideWorkspace } from "../tools/pathSafe.js";
import { assertBackgroundCommandAllowed } from "../policy/ShellPolicy.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { NotificationQueue } from "./NotificationQueue.js";
import type { BackgroundStartOptions, BackgroundTaskRecord } from "./types.js";

const MAX_OUTPUT_BYTES = 512 * 1024;

/** 在后台启动长时间命令，记录输出，完成后写入通知队列。 */
export class BackgroundTaskManager {
  private readonly tasks = new Map<string, BackgroundTaskRecord>();
  private readonly processes = new Map<string, ChildProcess>();
  private readonly cancelling = new Set<string>();
  private readonly timingOut = new Set<string>();
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly notifications: NotificationQueue,
    private readonly trace?: TraceLogger,
    private readonly onTaskDone?: (record: BackgroundTaskRecord) => void,
  ) {}

  start(command: string, options?: BackgroundStartOptions): BackgroundTaskRecord {
    const trimmed = command.trim();
    if (!trimmed) throw new Error("command 不能为空");

    assertBackgroundCommandAllowed(trimmed);

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
    };
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
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      appendOutput(record, "stderr", chunk);
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
    const level =
      record.status === "completed"
        ? "info"
        : record.status === "cancelled" || record.status === "timed_out"
          ? "warn"
          : "error";
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
      },
    });
    this.onTaskDone?.(record);
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
