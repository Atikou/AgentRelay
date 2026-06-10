import type { MemoryManager } from "./MemoryManager.js";
import type { MemoryRetriever } from "./MemoryRetriever.js";
import type { SemanticRetriever } from "./SemanticRetriever.js";
import type { SystemSectionBuilder } from "./SystemSectionBuilder.js";
import type { MessageStore, ProjectStore, SessionStore, SummaryStore, TaskStore } from "./stores.js";
import type { ContextMessage, ContextPackage, RestoreContextInput } from "./types.js";

export interface ContextRestorerOptions {
  recentMessageCount?: number;
}

/**
 * 收集上下文数据并返回 ContextPackage；不写死 system 文本。
 */
export class ContextRestorer {
  private readonly recentCount: number;

  constructor(
    private readonly sessions: SessionStore,
    private readonly messages: MessageStore,
    private readonly summaries: SummaryStore,
    private readonly projects: ProjectStore,
    private readonly tasks: TaskStore,
    private readonly memoryRetriever: MemoryRetriever,
    private readonly semanticRetriever: SemanticRetriever,
    private readonly sectionBuilder: SystemSectionBuilder,
    private readonly memoryManager: MemoryManager,
    options: ContextRestorerOptions = {},
  ) {
    this.recentCount = options.recentMessageCount ?? 10;
  }

  async restore(input: RestoreContextInput): Promise<ContextPackage> {
    const session = this.sessions.get(input.sessionId);
    const projectId = input.projectId ?? session?.projectId;
    const taskId = input.taskId ?? session?.activeTaskId;

    const sessionSummary = this.summaries.latestByType(input.sessionId, "session_summary");
    const chunkSummaries = this.summaries
      .listBySession(input.sessionId)
      .filter((s) => s.summaryType === "chunk_summary")
      .slice(-3);

    const recent = this.messages.getRecentUnsummarized(input.sessionId, this.recentCount);
    const chatMessages: ContextMessage[] = recent.map((m) => ({
      id: m.id,
      role: normalizeMessageRole(m.role),
      content: m.content,
      createdAt: m.createdAt,
    }));

    const userInput = input.userInput ?? "";
    const retrievedMemories = userInput
      ? await this.memoryRetriever.retrieve({
          userInput,
          sessionId: input.sessionId,
          projectId,
          taskId,
        })
      : [];

    const semanticHits = userInput
      ? await this.semanticRetriever.search({
          query: userInput,
          sessionId: input.sessionId,
          projectId,
          taskId,
        })
      : [];

    const project = projectId ? this.projects.get(projectId) : null;
    const activeTask = taskId
      ? this.tasks.get(taskId)
      : this.tasks.getActiveForSession(input.sessionId);
    const globalPreferences = this.memoryManager.listGlobalPreferences(10);
    const projectMemories = projectId
      ? this.memoryManager.listProjectMemories(projectId, 10)
      : [];
    const recentTools = this.messages.listRecentByRole(input.sessionId, "tool", 5);
    const recentToolSummaries = summarizeToolMessages(recentTools);

    const systemSections = this.sectionBuilder.build({
      sessionId: input.sessionId,
      projectId,
      taskId,
      globalPreferences,
      projectMemories,
      sessionSummary,
      chunkSummaries,
      retrievedMemories,
      semanticHits,
      project,
      activeTask,
      recentToolSummaries,
    });

    return {
      sessionId: input.sessionId,
      projectId,
      taskId,
      systemSections,
      messages: chatMessages,
      summaries: sessionSummary ? [sessionSummary, ...chunkSummaries] : chunkSummaries,
      memories: retrievedMemories,
      semanticHits,
      projectContext: project ?? undefined,
      activeTask: activeTask ?? undefined,
    };
  }
}

function normalizeMessageRole(role: string): ContextMessage["role"] {
  if (role === "assistant") return "assistant";
  if (role === "tool") return "tool";
  if (role === "system") return "system";
  return "user";
}

function summarizeToolMessages(messages: Array<{ id: string; content: string }>): string[] {
  return messages.map((m) => {
    const match = m.content.match(/^工具「([^」]+)」/);
    const tool = match?.[1] ?? "tool";
    const body = m.content.replace(/^工具「[^」]+」[^:\n]*[：:]?\n?/, "").trim();
    const preview = body.length > 180 ? `${body.slice(0, 180)}…` : body;
    return `${tool}: ${preview}`;
  });
}
