/** 后台任务生命周期状态。 */
export type BackgroundTaskStatus = "running" | "completed" | "failed" | "cancelled" | "timed_out";

export interface BackgroundStartOptions {
  cwd?: string;
  /** 超时后终止进程树；未设置则不自动超时。 */
  timeoutMs?: number;
}

export interface BackgroundTaskRecord {
  id: string;
  command: string;
  cwd: string;
  pid?: number;
  timeoutMs?: number;
  status: BackgroundTaskStatus;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  startedAt: string;
  endedAt?: string;
  error?: string;
}

export type NotificationLevel = "info" | "warn" | "error";
export type NotificationPriority = "low" | "normal" | "high";
export type NotificationSource = "background_task" | "system" | "scheduler";

export interface AgentNotification {
  id: string;
  source: NotificationSource;
  level: NotificationLevel;
  timestamp: string;
  message: string;
  priority?: NotificationPriority;
  taskId?: string;
  runId?: string;
  dedupeKey?: string;
  mergeKey?: string;
  payload?: Record<string, unknown>;
  consumed: boolean;
}

/** JSONL 回放：标记一批通知已在安全点消费。 */
export interface NotificationConsumeRecord {
  op: "consume";
  ids: string[];
  time: string;
}

export type NotificationJournalLine = AgentNotification | NotificationConsumeRecord;
