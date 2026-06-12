import type { AppContext } from "../../app/createAppContext.js";
import { parseBackgroundTimeoutMs } from "../../background/constants.js";
import {
  BackgroundTriggerOnMatchSchema,
  OutputMatchRuleSchema,
} from "../../background/outputMatcher.js";
import type { ApiResult } from "../../orchestrator/Orchestrator.js";
import { checkCommandRisk } from "../../tools/risk.js";

export function handleBackgroundList(app: AppContext) {
  return { tasks: app.backgroundTasks.list() };
}

export function handleBackgroundStart(app: AppContext, body: unknown): ApiResult {
  const payload = (body ?? {}) as {
    command?: string;
    cwd?: string;
    confirm?: boolean;
    timeoutMs?: number;
    outputRules?: unknown;
    triggerOnMatch?: unknown;
  };
  const command = (payload.command ?? "").trim();
  if (!command) return { status: 400, body: { error: "command 不能为空" } };
  const risk = checkCommandRisk(command);
  if (risk.level === "dangerous") {
    return { status: 400, body: { error: `危险命令被拒绝：${risk.reason}`, risk } };
  }
  if (risk.level === "caution" && !payload.confirm) {
    return {
      status: 200,
      body: { needsConfirmation: true, command, risk },
    };
  }
  let timeoutMs: number | undefined;
  try {
    timeoutMs = parseBackgroundTimeoutMs(payload.timeoutMs);
  } catch (error) {
    return { status: 400, body: { error: String(error) } };
  }

  let outputRules;
  if (payload.outputRules !== undefined) {
    const parsed = OutputMatchRuleSchema.array().safeParse(payload.outputRules);
    if (!parsed.success) {
      return { status: 400, body: { error: "outputRules 格式无效", details: parsed.error.flatten() } };
    }
    outputRules = parsed.data;
  }
  let triggerOnMatch;
  if (payload.triggerOnMatch !== undefined) {
    const parsed = BackgroundTriggerOnMatchSchema.safeParse(payload.triggerOnMatch);
    if (!parsed.success) {
      return { status: 400, body: { error: "triggerOnMatch 格式无效", details: parsed.error.flatten() } };
    }
    triggerOnMatch = parsed.data;
  }
  if (triggerOnMatch && (!outputRules || outputRules.length === 0)) {
    return { status: 400, body: { error: "triggerOnMatch 需要至少一条 outputRules" } };
  }

  try {
    const task = app.backgroundTasks.start(command, {
      cwd: payload.cwd,
      timeoutMs,
      outputRules,
      triggerOnMatch,
    });
    return { status: 200, body: { task } };
  } catch (error) {
    return { status: 400, body: { error: String(error) } };
  }
}

export function handleBackgroundGet(app: AppContext, id: string): ApiResult {
  const task = app.backgroundTasks.get(id);
  if (!task) return { status: 404, body: { error: "任务不存在" } };
  return { status: 200, body: { task } };
}

export function handleBackgroundCancel(app: AppContext, id: string): ApiResult {
  const task = app.backgroundTasks.cancel(id);
  if (!task) return { status: 404, body: { error: "任务不存在或已结束" } };
  return { status: 200, body: { task } };
}

export function handleNotificationsList(app: AppContext, pendingOnly: boolean) {
  const notifications = pendingOnly
    ? app.notificationQueue.listPending()
    : app.notificationQueue.listAll();
  return { notifications };
}

export function handleNotificationsConsume(app: AppContext) {
  const notifications = app.notificationQueue.drain();
  return { consumed: notifications };
}
