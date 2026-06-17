import { statSync } from "node:fs";
import path from "node:path";

import type { AppContext } from "../../app/createAppContext.js";
import type { ApiResult } from "../../orchestrator/Orchestrator.js";
import type { MemoryScope, MemoryType } from "../../context/index.js";
import { encodeCustomWorkspaceRoot } from "../../config/workspaceCatalog.js";

export function handleContextSessionsList(app: AppContext) {
  return { sessions: app.contextManager.listSessions() };
}

export function handleContextSessionCreate(app: AppContext, body: unknown): ApiResult {
  const payload = (body ?? {}) as {
    title?: string;
    projectId?: string;
    workspaceKey?: string;
    workspaceRoot?: string;
  };
  let workspaceKey = payload.workspaceKey?.trim();
  const workspaceRootRaw = payload.workspaceRoot?.trim();
  if (workspaceRootRaw) {
    const workspaceRoot = path.resolve(workspaceRootRaw);
    try {
      const stat = statSync(workspaceRoot);
      if (!stat.isDirectory()) {
        return { status: 400, body: { error: `workspaceRoot 不是目录：${workspaceRoot}` } };
      }
    } catch {
      return { status: 400, body: { error: `workspaceRoot 不存在：${workspaceRoot}` } };
    }
    workspaceKey = encodeCustomWorkspaceRoot(workspaceRoot);
  }
  if (workspaceKey && !app.isValidWorkspaceKey(workspaceKey, true)) {
    return { status: 400, body: { error: `无效的工作区：${workspaceKey}` } };
  }
  const session = app.contextManager.createSession(
    payload.title,
    payload.projectId,
    workspaceKey || undefined,
  );
  return { status: 200, body: { session } };
}

export function handleContextSessionGet(app: AppContext, id: string): ApiResult {
  const session = app.contextManager.getSession(id);
  if (!session) return { status: 404, body: { error: "会话不存在" } };
  const messages = app.contextManager.messages.listBySession(id);
  const summaries = app.contextManager.summaries.listBySession(id);
  return { status: 200, body: { session, messages, summaries } };
}

export function handleContextSessionUpdate(app: AppContext, id: string, body: unknown): ApiResult {
  const payload = (body ?? {}) as { title?: string };
  const title = (payload.title ?? "").trim();
  if (!title) return { status: 400, body: { error: "title 不能为空" } };
  const session = app.contextManager.updateSessionTitle(id, title);
  if (!session) return { status: 404, body: { error: "会话不存在", sessionId: id } };
  return { status: 200, body: { session } };
}

export async function handleContextSessionRestore(
  app: AppContext,
  id: string,
  query?: string,
  phase: "pre_call" | "post_call" = "pre_call",
): Promise<ApiResult> {
  const session = app.contextManager.getSession(id);
  if (!session) return { status: 404, body: { error: "会话不存在" } };
  const snapshot = await app.contextManager.buildContextSnapshot(id, {
    phase,
    userInput: query,
    currentUser: phase === "pre_call" ? query : undefined,
  });
  return { status: 200, body: { session, ...snapshot } };
}

export async function handleContextSessionCompress(app: AppContext, id: string): Promise<ApiResult> {
  const session = app.contextManager.getSession(id);
  if (!session) return { status: 404, body: { error: "会话不存在" } };
  const compressed = await app.contextManager.summaryManager.compressIfNeeded(id);
  app.contextManager.summaryManager.ensureSessionSummary(id);
  return {
    status: 200,
    body: { compressed, needsCompression: app.contextManager.summaryManager.needsCompression(id) },
  };
}

export async function handleContextSearch(app: AppContext, url: URL): Promise<ApiResult> {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return { status: 400, body: { error: "q 不能为空" } };
  const scope = url.searchParams.get("scope") as MemoryScope | null;
  const scopeId = url.searchParams.get("scopeId") ?? undefined;
  const tagsParam = url.searchParams.get("tags")?.trim();
  const tags = tagsParam
    ? tagsParam.split(",").map((t) => t.trim()).filter(Boolean)
    : undefined;
  try {
    const hits = await app.contextManager.search(q, scope ?? undefined, scopeId, tags);
    return { status: 200, body: { hits } };
  } catch (error) {
    return {
      status: 200,
      body: {
        hits: [],
        warning: `向量检索暂不可用，已降级为仅 FTS：${String(error)}`,
      },
    };
  }
}

export function handleContextProjectIndex(app: AppContext, url: URL) {
  const projectId = url.searchParams.get("projectId")?.trim() || "default";
  const stats = app.projectIndex.getStats(projectId, app.workspaceRoot);
  return { status: 200, body: { stats } };
}

export function handleContextMemoriesList(app: AppContext, url: URL) {
  const scope = url.searchParams.get("scope") as MemoryScope | null;
  const scopeId = url.searchParams.get("scopeId") ?? undefined;
  const memories = app.contextManager.listMemories(scope ?? undefined, scopeId);
  return { status: 200, body: { memories } };
}

export function handleContextMemoryDeactivate(
  app: AppContext,
  id: string,
  body: unknown,
): ApiResult {
  const memory = app.contextManager.getMemory(id);
  if (!memory) return { status: 404, body: { error: "记忆不存在" } };
  const payload = (body ?? {}) as { reason?: string };
  const reason = payload.reason?.trim() || "manual";
  const ok = app.contextManager.deactivateMemory(id, reason);
  if (!ok) return { status: 404, body: { error: "记忆不存在或已停用" } };
  return { status: 200, body: { memoryId: id, deactivated: true, reason } };
}

export function handleContextMemoryCreate(app: AppContext, body: unknown): ApiResult {
  const payload = (body ?? {}) as {
    scope?: MemoryScope;
    scopeId?: string;
    memoryType?: MemoryType;
    key?: string;
    value?: string;
    summary?: string;
    importance?: number;
  };
  if (!payload.scope) return { status: 400, body: { error: "scope 不能为空" } };
  if (!payload.memoryType) return { status: 400, body: { error: "memoryType 不能为空" } };
  if (!payload.value?.trim()) return { status: 400, body: { error: "value 不能为空" } };
  const memory = app.contextManager.upsertMemory({
    scope: payload.scope,
    scopeId: payload.scopeId,
    memoryType: payload.memoryType,
    key: payload.key,
    value: payload.value.trim(),
    summary: payload.summary,
    importance: payload.importance,
  });
  return { status: 200, body: { memory } };
}
