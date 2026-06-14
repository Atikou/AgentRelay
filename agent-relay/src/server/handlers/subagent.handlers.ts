import type { AppContext } from "../../app/createAppContext.js";
import type { ApiResult } from "../../orchestrator/Orchestrator.js";
import { listSubAgentRoles, type SubAgentRoleId } from "../../subagent/index.js";
import type { RunBudget } from "../../agent/RunPolicyTypes.js";

export function handleSubAgentRoles() {
  return { roles: listSubAgentRoles() };
}

export async function handleSubAgentRun(app: AppContext, body: unknown): Promise<ApiResult> {
  const payload = (body ?? {}) as {
    role?: SubAgentRoleId;
    task?: string;
    context?: string;
    parentTaskId?: string;
    grantedPermissions?: string[];
    budget?: Partial<RunBudget>;
    timeoutMs?: number;
    sensitive?: boolean;
    clientName?: string;
  };
  const task = (payload.task ?? "").trim();
  if (!payload.role) return { status: 400, body: { error: "role 不能为空" } };
  if (!task) return { status: 400, body: { error: "task 不能为空" } };

  const { forceClient, error } = app.resolveForceClient(payload.clientName);
  if (error) return { status: 404, body: { error } };

  return app.orchestrator.runSubAgent(body, forceClient);
}

export async function handleSubAgentBatch(app: AppContext, body: unknown): Promise<ApiResult> {
  const payload = (body ?? {}) as {
    roles?: SubAgentRoleId[];
    task?: string;
    context?: string;
    parentTaskId?: string;
    grantedPermissions?: string[];
    budget?: Partial<RunBudget>;
    timeoutMs?: number;
    sensitive?: boolean;
    clientName?: string;
  };
  const task = (payload.task ?? "").trim();
  if (!task) return { status: 400, body: { error: "task 不能为空" } };
  if (!payload.roles?.length) return { status: 400, body: { error: "roles 不能为空" } };

  const { forceClient, error } = app.resolveForceClient(payload.clientName);
  if (error) return { status: 404, body: { error } };

  return app.orchestrator.runSubAgentBatch(body, forceClient);
}

export function handleSubAgentRunning(app: AppContext): ApiResult {
  const coord = app.subAgentCoordinator;
  if (!coord) return { status: 503, body: { error: "子 Agent 未启用" } };
  return { status: 200, body: { running: coord.listRunning() } };
}

export function handleSubAgentCancel(app: AppContext, body: unknown): ApiResult {
  const payload = (body ?? {}) as { subAgentId?: string };
  const subAgentId = (payload.subAgentId ?? "").trim();
  if (!subAgentId) return { status: 400, body: { error: "subAgentId 不能为空" } };
  return app.orchestrator.cancelSubAgent(subAgentId);
}
