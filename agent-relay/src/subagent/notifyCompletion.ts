import type { NotificationQueue } from "../background/NotificationQueue.js";
import type { NotificationLevel } from "../background/types.js";
import type { SubAgentRoleId, SubAgentStatus } from "./types.js";

export function enqueueSubAgentCompletionNotification(
  queue: NotificationQueue,
  input: {
    subAgentId: string;
    role: SubAgentRoleId;
    parentTaskId?: string;
    runId?: string;
    status: SubAgentStatus;
    answer: string;
    error?: string;
  },
): void {
  const level = levelForStatus(input.status);
  queue.enqueue({
    source: "subagent",
    level,
    message: `子 Agent「${input.role}」${statusLabel(input.status)}`,
    taskId: input.parentTaskId,
    runId: input.runId,
    dedupeKey: `subagent:${input.subAgentId}`,
    priority: level === "error" ? "high" : "normal",
    payload: {
      role: input.role,
      status: input.status,
      subAgentId: input.subAgentId,
      answerPreview: input.answer.slice(0, 500),
      error: input.error,
    },
  });
}

function levelForStatus(status: SubAgentStatus): NotificationLevel {
  if (status === "completed") return "info";
  if (status === "timeout" || status === "cancelled") return "warn";
  return "error";
}

function statusLabel(status: SubAgentStatus): string {
  switch (status) {
    case "completed":
      return "已完成";
    case "timeout":
      return "已超时";
    case "cancelled":
      return "已取消";
    default:
      return "执行失败";
  }
}
