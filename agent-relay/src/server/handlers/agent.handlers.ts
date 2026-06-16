import type { IncomingMessage, ServerResponse } from "node:http";

import { Planner } from "../../agent/Planner.js";
import type { ActivityAgentRun } from "../../agent/timeline/types.js";
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

export async function handleChatStream(
  app: AppContext,
  body: unknown,
  res: ServerResponse,
): Promise<void> {
  const payload = (body ?? {}) as { clientName?: string; message?: string };
  const { error } = app.resolveForceClient(payload.clientName);
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
  try {
    await app.orchestrator.runChatStream(body, (event) => writeSseEvent(res, event.type, event));
  } catch (error) {
    writeSseEvent(res, "error", { type: "error", error: String(error), runId: "" });
  }
  endSse(res);
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

export async function handleAgentResume(app: AppContext, body: unknown): Promise<ApiResult> {
  const payload = (body ?? {}) as { clientName?: string };
  const { forceClient, error } = app.resolveForceClient(payload.clientName);
  if (error) return { status: 404, body: { error } };
  const makeChat = forceClient ? app.makeChatFn(forceClient) : undefined;
  return app.orchestrator.resumeAgent(body, makeChat);
}

export async function handleAgentStream(
  app: AppContext,
  body: unknown,
  res: ServerResponse,
  req?: IncomingMessage,
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

  // 客户端断线即取消运行：避免 SSE 断开后 Agent 仍在后台消耗模型/工具预算。
  let streamRunId: string | undefined;
  let clientGone = false;
  const onClose = () => {
    clientGone = true;
    if (streamRunId) app.orchestrator.cancelRun(streamRunId);
  };
  req?.on("close", onClose);

  try {
    await app.orchestrator.runAgentStream(
      body,
      (event) => {
        if (event.type === "run_start" && typeof event.runId === "string") {
          streamRunId = event.runId;
          // 断线发生在 run_start 之前的竞态：拿到 runId 立即补发取消。
          if (clientGone) app.orchestrator.cancelRun(streamRunId);
        }
        writeSseEvent(res, event.type, event);
      },
      makeChat,
    );
  } finally {
    req?.off("close", onClose);
  }
  endSse(res);
}

export function handleActivityRunGet(app: AppContext, runId: string, res: ServerResponse): void {
  const id = runId.trim();
  if (!id) {
    sendJson(res, 400, { error: "runId 不能为空" });
    return;
  }
  const result = app.orchestrator.getActivityRun(id);
  sendJson(res, result.status, result.body);
}

/** SSE：重放 `events.jsonl` 并订阅进程内实时 Activity 事件（断线可重连）。 */
export function handleActivityRunEvents(
  app: AppContext,
  runId: string,
  res: ServerResponse,
  req: IncomingMessage,
): void {
  const id = runId.trim();
  if (!id) {
    sendJson(res, 400, { error: "runId 不能为空" });
    return;
  }
  const snapshot = app.orchestrator.getActivityRun(id);
  if (snapshot.status === 404) {
    sendJson(res, 404, snapshot.body);
    return;
  }

  initSse(res);
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    endSse(res);
  };

  let terminalSeen = false;
  const unsubscribe = app.orchestrator.subscribeActivityEvents(id, (event) => {
    if (closed) return;
    writeSseEvent(res, event.type, event);
    if (
      event.type === "run_completed" ||
      event.type === "run_failed" ||
      event.type === "run_cancelled"
    ) {
      terminalSeen = true;
      unsubscribe();
      finish();
    }
  });

  if (!terminalSeen) {
    const run = (snapshot.body as { run: ActivityAgentRun }).run;
    if (run.status !== "running" && run.status !== "pending") {
      unsubscribe();
      finish();
    }
  }

  req.on("close", () => {
    closed = true;
    unsubscribe();
  });
}
