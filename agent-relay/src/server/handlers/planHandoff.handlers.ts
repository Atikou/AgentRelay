import type { AppContext } from "../../app/createAppContext.js";
import type { ApiResult } from "../../orchestrator/Orchestrator.js";
import { defaultPlanHandoffStore } from "../../policy/PlanHandoffStore.js";
import type { PlanHandoffDecision } from "../../policy/planHandoffTypes.js";

function parseDecision(value: unknown): PlanHandoffDecision | undefined {
  if (value === "approve" || value === "reject") return value;
  return undefined;
}

export function handlePlanHandoffGet(app: AppContext, id: string): ApiResult {
  const handoff = app.planHandoffStore.get(id.trim());
  if (!handoff) return { status: 404, body: { error: "计划交接不存在", id } };
  return { status: 200, body: { planHandoff: handoff } };
}

export function handlePlanHandoffsPending(app: AppContext, url: URL): ApiResult {
  const sessionId = url.searchParams.get("sessionId") ?? undefined;
  const runId = url.searchParams.get("runId") ?? undefined;
  const pending = app.planHandoffStore.listPending({ sessionId, runId });
  return { status: 200, body: { planHandoffs: pending, count: pending.length } };
}

export function handlePlanHandoffRespond(app: AppContext, id: string, body: unknown): ApiResult {
  const payload = (body ?? {}) as { decision?: unknown };
  const decision = parseDecision(payload.decision);
  if (!decision) {
    return { status: 400, body: { error: "decision 必须是 approve / reject" } };
  }

  const responded = app.planHandoffStore.respond(id.trim(), { decision });
  if (!responded) {
    return { status: 404, body: { error: "计划交接不存在或已处理", id } };
  }

  if (decision === "reject") {
    app.runs.update(responded.runId, { status: "cancelled" });
    app.pausedRunStore?.delete(responded.runId);
  } else {
    app.runs.update(responded.runId, { status: "waiting_plan_handoff" });
  }

  return {
    status: 200,
    body: {
      planHandoff: responded,
      runId: responded.runId,
      status: decision === "reject" ? "rejected" : "approved",
    },
  };
}

export { defaultPlanHandoffStore };
