import type { AppContext } from "../../app/createAppContext.js";
import type { ApiResult } from "../../orchestrator/Orchestrator.js";
import { CreateTriggerInputSchema } from "../../scheduler/index.js";

export function handleSchedulerList(app: AppContext) {
  return { triggers: app.scheduler.list() };
}

export function handleSchedulerCreate(app: AppContext, body: unknown): ApiResult {
  const parsed = CreateTriggerInputSchema.safeParse(body);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: parsed.error.issues.map((i) => i.message).join("; ") },
    };
  }
  try {
    const trigger = app.scheduler.register(parsed.data);
    return { status: 200, body: { trigger } };
  } catch (error) {
    return { status: 400, body: { error: String(error) } };
  }
}

export function handleSchedulerPause(app: AppContext, id: string): ApiResult {
  const trigger = app.scheduler.pause(id);
  if (!trigger) return { status: 404, body: { error: "触发器不存在" } };
  return { status: 200, body: { trigger } };
}

export function handleSchedulerResume(app: AppContext, id: string): ApiResult {
  const trigger = app.scheduler.resume(id);
  if (!trigger) return { status: 404, body: { error: "触发器不存在" } };
  return { status: 200, body: { trigger } };
}

export function handleSchedulerCancel(app: AppContext, id: string): ApiResult {
  const trigger = app.scheduler.cancel(id);
  if (!trigger) return { status: 404, body: { error: "触发器不存在" } };
  return { status: 200, body: { trigger } };
}
