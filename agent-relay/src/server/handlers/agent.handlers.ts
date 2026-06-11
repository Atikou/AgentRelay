import type { ServerResponse } from "node:http";

import { Planner } from "../../agent/Planner.js";
import type { AppContext } from "../../app/createAppContext.js";
import type { ApiResult } from "../../orchestrator/Orchestrator.js";
import { sendJson } from "../http/response.js";
import { endSse, initSse, writeSseEvent } from "../http/sse.js";

export async function handleChat(app: AppContext, body: unknown): Promise<ApiResult> {
  const payload = (body ?? {}) as { clientName?: string };
  const { error } = app.resolveForceClient(payload.clientName);
  if (error) return { status: 404, body: { error } };
  return app.orchestrator.runChat(body);
}

export async function handlePlan(app: AppContext, body: unknown): Promise<ApiResult> {
  const payload = (body ?? {}) as { clientName?: string };
  const { forceClient, error } = app.resolveForceClient(payload.clientName);
  if (error) return { status: 404, body: { error } };
  const planner = forceClient ? new Planner(app.makeChatFn(forceClient)) : undefined;
  return app.orchestrator.generatePlan(body, planner);
}

export async function handleTaskDryRun(app: AppContext, body: unknown): Promise<ApiResult> {
  return app.orchestrator.runTask(body, true);
}

export async function handleTaskRun(app: AppContext, body: unknown): Promise<ApiResult> {
  const payload = (body ?? {}) as { clientName?: string };
  const { forceClient, error } = app.resolveForceClient(payload.clientName);
  if (error) return { status: 404, body: { error } };
  const planner = forceClient ? new Planner(app.makeChatFn(forceClient)) : undefined;
  return app.orchestrator.runTask(body, false, planner);
}

export async function handleAgent(app: AppContext, body: unknown): Promise<ApiResult> {
  const payload = (body ?? {}) as { clientName?: string };
  const { forceClient, error } = app.resolveForceClient(payload.clientName);
  if (error) return { status: 404, body: { error } };
  const makeChat = forceClient ? app.makeChatFn(forceClient) : undefined;
  return app.orchestrator.runAgent(body, makeChat);
}

export async function handleAgentStream(
  app: AppContext,
  body: unknown,
  res: ServerResponse,
): Promise<void> {
  const payload = (body ?? {}) as { clientName?: string; message?: string };
  const { forceClient, error } = app.resolveForceClient(payload.clientName);
  if (error) {
    sendJson(res, 404, { error });
    return;
  }
  const message = (payload.message ?? "").trim();
  if (!message) {
    sendJson(res, 400, { error: "message 不能为空" });
    return;
  }

  initSse(res);
  const makeChat = forceClient ? app.makeChatFn(forceClient) : undefined;
  await app.orchestrator.runAgentStream(
    body,
    (event) => writeSseEvent(res, event.type, event),
    makeChat,
  );
  endSse(res);
}
