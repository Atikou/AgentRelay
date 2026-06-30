import type { ServerResponse } from "node:http";

import type { AppContext } from "../../app/createAppContext.js";
import type { CompanionChatInput } from "../../companion/types.js";
import type { ApiResult } from "../../orchestrator/Orchestrator.js";
import { sendJson } from "../http/response.js";
import { endSse, initSse, writeSseEvent } from "../http/sse.js";

function forceClientError(app: AppContext, clientName?: string): { forceClient?: string; error?: string } {
  return app.resolveForceClient(clientName);
}

export async function handleCompanionChat(app: AppContext, body: unknown): Promise<ApiResult> {
  const payload = (body ?? {}) as { clientName?: string };
  const { forceClient, error } = forceClientError(app, payload.clientName);
  if (error) return { status: 404, body: { error } };
  try {
    const request = { ...(body as Record<string, unknown>), clientName: forceClient } as CompanionChatInput;
    const result = await app.companionService.chat(request);
    return { status: 200, body: result };
  } catch (err) {
    return { status: 400, body: { error: String(err) } };
  }
}

export async function handleCompanionChatStream(
  app: AppContext,
  body: unknown,
  res: ServerResponse,
): Promise<void> {
  const payload = (body ?? {}) as { clientName?: string; message?: string };
  const { forceClient, error } = forceClientError(app, payload.clientName);
  if (error) {
    sendJson(res, 404, { error });
    return;
  }
  if (!payload.message?.trim()) {
    sendJson(res, 400, { error: "message 不能为空" });
    return;
  }
  initSse(res);
  const request = { ...(body as Record<string, unknown>), clientName: forceClient } as CompanionChatInput;
  await app.companionService.chatStream(
    request,
    (event) => writeSseEvent(res, event.type, event),
  );
  endSse(res);
}

export function handleCompanionSessionsList(app: AppContext, url: URL): ApiResult {
  return {
    status: 200,
    body: app.companionService.listSessions(url.searchParams.get("storageRoot") ?? undefined),
  };
}

export function handleCompanionSessionCreate(app: AppContext, body: unknown): ApiResult {
  const payload = (body ?? {}) as { storageRoot?: string; personaId?: string; title?: string };
  try {
    return { status: 200, body: app.companionService.createSession(payload) };
  } catch (error) {
    return { status: 400, body: { error: String(error) } };
  }
}

export function handleCompanionSessionMessages(app: AppContext, sessionId: string, url: URL): ApiResult {
  const result = app.companionService.listMessages({
    sessionId,
    storageRoot: url.searchParams.get("storageRoot") ?? undefined,
    limit: Number(url.searchParams.get("limit") ?? 100),
  });
  if (!result) return { status: 404, body: { error: "Companion 会话不存在", sessionId } };
  return { status: 200, body: result };
}

export async function handleCompanionSessionSummarize(
  app: AppContext,
  sessionId: string,
  body: unknown,
): Promise<ApiResult> {
  const payload = (body ?? {}) as { storageRoot?: string; force?: boolean; outputMode?: "bounded" | "unrestricted" | "raw" };
  const result = await app.companionService.summarize({
    sessionId,
    storageRoot: payload.storageRoot,
    force: payload.force,
    outputMode: payload.outputMode,
  });
  if (!result) return { status: 404, body: { error: "Companion 会话不存在", sessionId } };
  return { status: 200, body: result };
}

export function handleCompanionStorageStatus(app: AppContext, url: URL): ApiResult {
  try {
    return {
      status: 200,
      body: { storage: app.companionService.storageStatus(url.searchParams.get("storageRoot") ?? undefined) },
    };
  } catch (error) {
    return { status: 400, body: { error: String(error) } };
  }
}

export function handleCompanionVectorStatus(app: AppContext, url: URL): ApiResult {
  try {
    return {
      status: 200,
      body: { vector: app.companionService.vectorStatus(url.searchParams.get("storageRoot") ?? undefined) },
    };
  } catch (error) {
    return { status: 400, body: { error: String(error) } };
  }
}
