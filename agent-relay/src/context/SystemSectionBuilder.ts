import type { FileSnippetItem } from "./fileSnippets.js";
import type {
  ContextPackage,
  MemoryRecord,
  ProjectRecord,
  RetrievedMemory,
  SemanticHit,
  SummaryRecord,
  SystemSection,
  SystemSectionItem,
  TaskRecord,
  TaskStepRecord,
} from "./types.js";

export interface BuildSystemSectionsInput {
  sessionId: string;
  projectId?: string;
  taskId?: string;
  globalPreferences: MemoryRecord[];
  projectMemories: MemoryRecord[];
  sessionSummary?: SummaryRecord | null;
  chunkSummaries: SummaryRecord[];
  retrievedMemories: RetrievedMemory[];
  semanticHits: SemanticHit[];
  project?: ProjectRecord | null;
  activeTask?: TaskRecord | null;
  planSteps?: TaskStepRecord[];
  fileSnippets?: FileSnippetItem[];
  recentToolSummaries?: string[];
}

/** 将结构化上下文格式化为可注入模型的 systemSections。 */
export class SystemSectionBuilder {
  build(input: BuildSystemSectionsInput): SystemSection[] {
    const sections: SystemSection[] = [];

    const prefs = dedupeItems(
      input.globalPreferences.map((m) => memoryItem(m)),
      "memory",
    );
    if (prefs.length > 0) {
      sections.push({
        type: "user_preferences",
        title: "用户偏好",
        priority: 100,
        items: prefs,
      });
    }

    const summaryItems = buildSummaryItems(input.sessionSummary, input.chunkSummaries);
    if (summaryItems.length > 0) {
      sections.push({
        type: "session_summary",
        title: "历史摘要",
        priority: 90,
        items: summaryItems,
      });
    }

    if (input.activeTask) {
      const taskText = input.activeTask.summary
        ? `${input.activeTask.goal}（${input.activeTask.status}）— ${input.activeTask.summary}`
        : `${input.activeTask.goal}（${input.activeTask.status}）`;
      sections.push({
        type: "task_state",
        title: "当前任务",
        priority: 85,
        items: [{ sourceType: "task", sourceId: input.activeTask.id, text: taskText }],
      });
    }

    if (input.planSteps?.length) {
      const planItems = input.planSteps.map((step) => ({
        sourceType: "task" as const,
        sourceId: step.stepId,
        text: formatPlanStepLine(step),
      }));
      sections.push({
        type: "current_plan",
        title: "当前计划",
        priority: 84,
        items: planItems,
      });
    }

    const projectItems = buildProjectItems(input.project, input.projectMemories);
    if (projectItems.length > 0) {
      sections.push({
        type: "project_context",
        title: "当前项目",
        priority: 80,
        items: projectItems,
      });
    }

    const shownMemoryIds = new Set([
      ...input.globalPreferences.map((m) => m.id),
      ...input.projectMemories.map((m) => m.id),
    ]);
    const memoryItems = dedupeItems(
      input.retrievedMemories
        .filter(
          (r) =>
            !shownMemoryIds.has(r.memory.id) &&
            r.reason !== "fixed_preference" &&
            r.reason !== "project_context" &&
            r.reason !== "task_context",
        )
        .map((r) => ({
          sourceType: "memory" as const,
          sourceId: r.memory.id,
          text: r.memory.summary ?? r.memory.value,
          score: r.score,
        })),
      "memory",
    );
    if (memoryItems.length > 0) {
      sections.push({
        type: "relevant_memories",
        title: "相关长期记忆",
        priority: 70,
        items: memoryItems,
      });
    }

    const semanticItems = dedupeItems(
      input.semanticHits.map((h) => ({
        sourceType: "semantic" as const,
        sourceId: h.item.sourceId,
        text: h.item.summary ?? h.item.content.slice(0, 300),
        score: h.score,
      })),
      "semantic",
    );
    if (semanticItems.length > 0) {
      sections.push({
        type: "semantic_results",
        title: "相关检索结果",
        priority: 60,
        items: semanticItems,
      });
    }

    if (input.fileSnippets?.length) {
      sections.push({
        type: "file_snippets",
        title: "文件与代码片段",
        priority: 52,
        items: input.fileSnippets.map((s) => ({
          sourceType: "file" as const,
          sourceId: s.messageId,
          text: `${s.path}（${s.tool}）\n${s.preview}`,
        })),
      });
    }

    if (input.recentToolSummaries?.length) {
      sections.push({
        type: "recent_tool_results",
        title: "最近工具结果",
        priority: 50,
        items: input.recentToolSummaries.map((text, i) => ({
          sourceType: "tool" as const,
          sourceId: `recent-tool-${i}`,
          text,
        })),
      });
    }

    sections.push({
      type: "response_rules",
      title: "回复约束",
      priority: 10,
      items: [
        {
          sourceType: "tool",
          text: "优先依据上述摘要与记忆回答；不确定时说明依据不足，勿编造未出现的偏好或项目事实。",
        },
      ],
    });

    return sections.sort((a, b) => b.priority - a.priority);
  }
}

function memoryItem(m: MemoryRecord): SystemSectionItem {
  return {
    sourceType: "memory",
    sourceId: m.id,
    text: m.summary ?? m.value,
    score: m.importance,
  };
}

function buildSummaryItems(
  sessionSummary: SummaryRecord | null | undefined,
  chunkSummaries: SummaryRecord[],
): SystemSectionItem[] {
  const items: SystemSectionItem[] = [];
  if (sessionSummary) {
    items.push({
      sourceType: "summary",
      sourceId: sessionSummary.id,
      text: formatStructuredSummary(sessionSummary.content),
    });
    return items;
  }
  for (const chunk of chunkSummaries.slice(-3)) {
    items.push({
      sourceType: "summary",
      sourceId: chunk.id,
      text: formatStructuredSummary(chunk.content),
    });
  }
  return items;
}

function buildProjectItems(
  project: ProjectRecord | null | undefined,
  memories: MemoryRecord[],
): SystemSectionItem[] {
  const items: SystemSectionItem[] = [];
  if (project) {
    const parts = [project.name];
    if (project.description) parts.push(project.description);
    if (project.rootPath) parts.push(`根路径：${project.rootPath}`);
    items.push({ sourceType: "project", sourceId: project.id, text: parts.join("；") });
  }
  for (const m of memories) {
    items.push({
      sourceType: "memory",
      sourceId: m.id,
      text: m.summary ?? m.value,
      score: m.importance,
    });
  }
  return dedupeItems(items, "memory");
}

function formatStructuredSummary(s: SummaryRecord["content"]): string {
  const parts: string[] = [];
  if (s.current_goal) parts.push(`目标：${s.current_goal}`);
  appendJoin(parts, "决策", s.important_decisions);
  appendJoin(parts, "偏好", s.user_preferences);
  appendJoin(parts, "项目状态", s.project_state);
  appendJoin(parts, "待解决", s.open_questions);
  appendJoin(parts, "近期变更", s.recent_changes);
  return parts.join("；") || "（无摘要文本）";
}

function appendJoin(parts: string[], label: string, items?: string[]): void {
  if (items?.length) parts.push(`${label}：${items.join("、")}`);
}

function formatPlanStepLine(step: TaskStepRecord): string {
  const idx = step.position + 1;
  const confirm = step.needsConfirmation ? "需确认" : "";
  const deps = step.dependsOn.length ? `依赖:${step.dependsOn.join(",")}` : "";
  const tail = [step.status, confirm, deps].filter(Boolean).join("；");
  const desc = step.description ? ` — ${step.description.slice(0, 120)}` : "";
  return `${idx}. ${step.title}（${tail}）${desc}`;
}

function dedupeItems(items: SystemSectionItem[], kind: string): SystemSectionItem[] {
  const seen = new Set<string>();
  const out: SystemSectionItem[] = [];
  for (const item of items) {
    const key = item.sourceId ? `${kind}:${item.sourceId}` : `${kind}:${item.text.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
