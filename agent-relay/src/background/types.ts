import type {
  BackgroundTriggerOnMatch,
  OutputMatchResult,
  OutputMatchRule,
} from "./outputTypes.js";

/** 后台任务生命周期状态。 */
export type BackgroundTaskStatus = "running" | "completed" | "failed" | "cancelled" | "timed_out";

export interface BackgroundStartOptions {
  cwd?: string;
  /** 超时后终止进程树；未设置则不自动超时。 */
  timeoutMs?: number;
  /** 对 stdout/stderr 的匹配规则（错误关键字、ready、测试完成等）。 */
  outputRules?: OutputMatchRule[];
  /** 规则命中后自动触发下一步 Agent goal（无人值守循环）。 */
  triggerOnMatch?: BackgroundTriggerOnMatch;
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
  outputRules?: OutputMatchRule[];
  outputMatches?: OutputMatchResult[];
  triggerOnMatch?: BackgroundTriggerOnMatch;
  /** 输出匹配触发下一步时关联的 Run id */
  triggeredRunId?: string;
}

export type NotificationLevel = "info" | "warn" | "error";
export type NotificationPriority = "low" | "normal" | "high";
export type NotificationSource = "background_task" | "system" | "scheduler" | "subagent";

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
