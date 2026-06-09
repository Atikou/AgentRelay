/** 后台任务生命周期状态。 */
export type BackgroundTaskStatus = "running" | "completed" | "failed" | "cancelled";

export interface BackgroundTaskRecord {
  id: string;
  command: string;
  cwd: string;
  pid?: number;
  status: BackgroundTaskStatus;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  startedAt: string;
  endedAt?: string;
  error?: string;
}

export type NotificationLevel = "info" | "warn" | "error";
export type NotificationSource = "background_task" | "system";

export interface AgentNotification {
  id: string;
  source: NotificationSource;
  level: NotificationLevel;
  timestamp: string;
  message: string;
  taskId?: string;
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
