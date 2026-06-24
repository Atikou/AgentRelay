/** 编排 Run 的类型（统一 Agent / Task / Chat / 子 Agent / 调度触发）。 */
export type RunKind =
  | "agent"
  | "task"
  | "task_dry_run"
  | "chat"
  | "plan"
  | "scheduled"
  | "subagent"
  | "subagent_batch";

export type RunStatus =
  | "pending"
  | "running"
  | "blocked"
  | "waiting_confirmation"
  | "waiting_plan_handoff"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunRecord {
  id: string;
  kind: RunKind;
  status: RunStatus;
  sessionId?: string;
  taskId?: string;
  parentRunId?: string;
  triggerId?: string;
  goal?: string;
  error?: string;
  resultJson?: string;
  correlationJson?: string;
  createdAt: string;
  updatedAt: string;
}
