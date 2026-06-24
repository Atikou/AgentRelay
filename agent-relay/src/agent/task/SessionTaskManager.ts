import { defaultWorkflowSessionStore } from "../WorkflowSessionSwitch.js";
import type { TaskContext, TaskPhase, UpdateTaskContextFromRunInput } from "./TaskContext.js";
import { SessionTaskStore } from "./SessionTaskStore.js";

export function resolvePhaseFromRun(input: UpdateTaskContextFromRunInput): TaskPhase {
  if (input.failed || input.stopReason === "error") return "failed";
  if (input.stopReason === "awaiting_plan_handoff") return "waiting_approval";
  if (input.stopReason === "awaiting_permission") return "waiting_approval";
  if (input.workflowTaskState === "completed") return "completed";
  if (input.workflowTaskState === "failed") return "failed";
  if (input.intent === "plan") return "planning";
  if (input.intent === "debug") return "debugging";
  if (input.intent === "verify" || input.intent === "run") return "verifying";
  if (input.intent === "edit" || input.intent === "generate_file" || input.intent === "refactor") {
    return "editing";
  }
  return "analyzing";
}

/** 会话级连续任务上下文：SQLite 持久化 + 内存 workflow 快照互补。 */
export class SessionTaskManager {
  private readonly store: SessionTaskStore;
  private readonly memory = new Map<string, TaskContext>();

  constructor(db?: import("node:sqlite").DatabaseSync) {
    this.store = new SessionTaskStore(db);
  }

  getContext(sessionId: string): TaskContext | undefined {
    const persisted = this.store.get(sessionId);
    if (persisted) return persisted;
    const cached = this.memory.get(sessionId);
    if (cached) return cached;
    const snapshot = defaultWorkflowSessionStore.get(sessionId);
    if (!snapshot) return undefined;
    return {
      sessionId,
      currentPhase: "analyzing",
      intent: snapshot.intent,
      workflowType: snapshot.workflowType,
      lastRunId: snapshot.runId,
      isActive: true,
      updatedAt: snapshot.updatedAt,
    };
  }

  markInactive(sessionId: string): void {
    this.memory.delete(sessionId);
    this.store.markInactive(sessionId);
  }

  updateFromRun(input: UpdateTaskContextFromRunInput): void {
    const phase = resolvePhaseFromRun(input);
    const context: TaskContext = {
      sessionId: input.sessionId,
      taskId: input.taskId,
      goal: input.goal,
      currentPhase: phase,
      intent: input.intent,
      workflowType: input.workflowType,
      lastRunId: input.runId,
      lastFailure: input.failureSummary ?? (phase === "failed" ? input.goal.slice(0, 500) : undefined),
      relatedFiles: input.relatedFiles,
      // 同会话任务默认保持活跃，直到用户明确换话题（markInactive）。
      isActive: true,
      updatedAt: new Date().toISOString(),
    };
    this.memory.set(input.sessionId, context);
    this.store.upsert(context);
  }
}

let _defaultSessionTaskManager = new SessionTaskManager();

export function wireSessionTaskManager(db: import("node:sqlite").DatabaseSync): SessionTaskManager {
  _defaultSessionTaskManager = new SessionTaskManager(db);
  return _defaultSessionTaskManager;
}

export const defaultSessionTaskManager: SessionTaskManager = new Proxy({} as SessionTaskManager, {
  get(_target, prop: keyof SessionTaskManager) {
    const value = _defaultSessionTaskManager[prop];
    return typeof value === "function" ? value.bind(_defaultSessionTaskManager) : value;
  },
});
