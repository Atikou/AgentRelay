import type { AppContext } from "../../app/createAppContext.js";
import type { ApiResult } from "../../orchestrator/Orchestrator.js";

export function handleTaskGet(app: AppContext, taskId: string): ApiResult {
  return app.orchestrator.getTask(taskId);
}

export function handleTasksList(app: AppContext, sessionId: string | undefined): ApiResult {
  if (!sessionId) {
    return { status: 400, body: { error: "需要 query 参数 sessionId" } };
  }
  const tasks = app.contextManager.tasks.listBySession(sessionId);
  return { status: 200, body: { tasks } };
}

export async function handleTaskResume(
  app: AppContext,
  taskId: string,
  body: unknown,
): Promise<ApiResult> {
  return app.orchestrator.resumeTask(taskId, body);
}
