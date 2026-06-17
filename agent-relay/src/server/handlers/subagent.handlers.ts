import type { AppContext } from "../../app/createAppContext.js";
import type { ApiResult } from "../../orchestrator/Orchestrator.js";
import type { DelegatedTask } from "../../subagent/delegatedTask.js";
import { getSubAgentLocalQueueGate } from "../../subagent/SubAgentLocalQueueGate.js";

export async function handleSubAgentRun(app: AppContext, body: unknown): Promise<ApiResult> {
  const payload = (body ?? {}) as {
    task?: DelegatedTask;
    parentTaskId?: string;
    grantedPermissions?: string[];
    timeoutMs?: number;
    sensitive?: boolean;
    clientName?: string;
  };

  if (!payload.task || typeof payload.task !== "object" || !payload.task.goal?.trim()) {
    return { status: 400, body: { error: "task 须为含 goal 的 DelegatedTask 对象" } };
  }

  const { forceClient, error } = app.resolveForceClient(payload.clientName);
  if (error) return { status: 404, body: { error } };

  return app.orchestrator.runSubAgent(body, forceClient);
}

export async function handleSubAgentBatch(app: AppContext, body: unknown): Promise<ApiResult> {
  const payload = (body ?? {}) as { tasks?: DelegatedTask[]; clientName?: string };
  if (!payload.tasks?.length) {
    return { status: 400, body: { error: "tasks 不能为空" } };
  }

  const { forceClient, error } = app.resolveForceClient(payload.clientName);
  if (error) return { status: 404, body: { error } };

  return app.orchestrator.runSubAgentBatch(body, forceClient);
}

export function handleSubAgentRunning(app: AppContext): ApiResult {
  const coord = app.subAgentCoordinator;
  if (!coord) return { status: 503, body: { error: "子 Agent 未启用" } };
  return { status: 200, body: { running: coord.listRunning() } };
}

export function handleSubAgentSchedule(app: AppContext): ApiResult {
  const gate = getSubAgentLocalQueueGate();
  const coord = app.subAgentCoordinator;
  return {
    status: 200,
    body: {
      running: coord?.listRunning() ?? [],
      localQueue: gate?.stats ?? { active: 0, maxConcurrent: 0, waiting: 0 },
      policy: {
        maxBatchConcurrency: app.config.security?.subagent?.maxBatchConcurrency ?? 2,
        defaultTimeoutMs: app.config.security?.subagent?.defaultTimeoutMs,
        localModelMaxConcurrent: app.config.security?.subagent?.localModelMaxConcurrent ?? 1,
      },
    },
  };
}

export function handleSubAgentCancel(app: AppContext, body: unknown): ApiResult {
  const payload = (body ?? {}) as { subAgentId?: string };
  const subAgentId = (payload.subAgentId ?? "").trim();
  if (!subAgentId) return { status: 400, body: { error: "subAgentId 不能为空" } };
  return app.orchestrator.cancelSubAgent(subAgentId);
}
