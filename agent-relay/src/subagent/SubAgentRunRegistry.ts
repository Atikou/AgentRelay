import type { SubAgentRoleId } from "./types.js";

export const SUB_AGENT_CANCELLED_MESSAGE = "子 Agent 已取消";

export interface SubAgentRunningRecord {
  subAgentId: string;
  role: SubAgentRoleId;
  parentTaskId?: string;
  startedAt: string;
}

export interface SubAgentCancelResult extends SubAgentRunningRecord {
  status: "cancelling";
}

interface ActiveRun {
  controller: AbortController;
  role: SubAgentRoleId;
  parentTaskId?: string;
  startedAt: string;
}

/** 跟踪运行中的子 Agent，支持显式 cancel（AbortSignal）。 */
export class SubAgentRunRegistry {
  private readonly active = new Map<string, ActiveRun>();

  /** 注册运行中子 Agent，返回用于取消的 AbortController。 */
  register(
    subAgentId: string,
    meta: { role: SubAgentRoleId; parentTaskId?: string },
  ): AbortController {
    const controller = new AbortController();
    this.active.set(subAgentId, {
      controller,
      role: meta.role,
      parentTaskId: meta.parentTaskId,
      startedAt: new Date().toISOString(),
    });
    return controller;
  }

  unregister(subAgentId: string): void {
    this.active.delete(subAgentId);
  }

  isRunning(subAgentId: string): boolean {
    return this.active.has(subAgentId);
  }

  listRunning(): SubAgentRunningRecord[] {
    return [...this.active.entries()].map(([subAgentId, entry]) => ({
      subAgentId,
      role: entry.role,
      parentTaskId: entry.parentTaskId,
      startedAt: entry.startedAt,
    }));
  }

  /** 请求取消；运行中的子 Agent 将在安全点以 cancelled 结束。 */
  cancel(subAgentId: string): SubAgentCancelResult | undefined {
    const entry = this.active.get(subAgentId);
    if (!entry) return undefined;
    if (!entry.controller.signal.aborted) {
      entry.controller.abort(new Error(SUB_AGENT_CANCELLED_MESSAGE));
    }
    return {
      subAgentId,
      role: entry.role,
      parentTaskId: entry.parentTaskId,
      startedAt: entry.startedAt,
      status: "cancelling",
    };
  }
}

export function isSubAgentCancelledError(err: unknown): boolean {
  const msg = String(err);
  if (msg.includes(SUB_AGENT_CANCELLED_MESSAGE)) return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}
