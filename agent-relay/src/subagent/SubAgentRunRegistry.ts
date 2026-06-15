export interface SubAgentRunningRecord {
  subAgentId: string;
  goal: string;
  parentTaskId?: string;
  startedAt: string;
}

export interface SubAgentCancelResult extends SubAgentRunningRecord {
  status: "cancelling";
}

interface ActiveRun {
  controller: AbortController;
  goal: string;
  parentTaskId?: string;
  startedAt: string;
}

export const SUB_AGENT_CANCELLED_MESSAGE = "子 Agent 已取消";

export class SubAgentRunRegistry {
  private readonly active = new Map<string, ActiveRun>();

  register(
    subAgentId: string,
    meta: { goal: string; parentTaskId?: string },
  ): AbortController {
    const controller = new AbortController();
    this.active.set(subAgentId, {
      controller,
      goal: meta.goal,
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
    return [...this.active.entries()].map(([subAgentId, run]) => ({
      subAgentId,
      goal: run.goal,
      parentTaskId: run.parentTaskId,
      startedAt: run.startedAt,
    }));
  }

  cancel(subAgentId: string): SubAgentCancelResult | undefined {
    const run = this.active.get(subAgentId);
    if (!run) return undefined;
    run.controller.abort(new Error(SUB_AGENT_CANCELLED_MESSAGE));
    return {
      subAgentId,
      goal: run.goal,
      parentTaskId: run.parentTaskId,
      startedAt: run.startedAt,
      status: "cancelling",
    };
  }
}

export function isSubAgentCancelledError(err: unknown): boolean {
  if (err instanceof Error && err.message === SUB_AGENT_CANCELLED_MESSAGE) return true;
  if (typeof err === "object" && err != null && "message" in err) {
    return String((err as { message: unknown }).message) === SUB_AGENT_CANCELLED_MESSAGE;
  }
  return false;
}
