import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { redactValue } from "../util/redact.js";

import type { ChatMessage } from "../model/types.js";
import { ContextRestorer } from "./ContextRestorer.js";
import { DatabaseManager } from "./DatabaseManager.js";
import { EmbeddingService, MockEmbeddingProvider } from "./EmbeddingService.js";
import { MemoryExtractor, type IMemoryExtractor } from "./MemoryExtractor.js";
import { MemoryManager } from "./MemoryManager.js";
import { MemoryRetriever } from "./MemoryRetriever.js";
import { PromptBuilder } from "./PromptBuilder.js";
import { SemanticRetriever } from "./SemanticRetriever.js";
import { SummaryManager } from "./SummaryManager.js";
import { SystemSectionBuilder } from "./SystemSectionBuilder.js";
import {
  MemoryStore,
  MessageStore,
  ProjectStore,
  SessionStore,
  SummaryStore,
  TaskStore,
} from "./stores.js";
import type {
  ContextDebugSnapshot,
  ContextPackage,
  ContextPhase,
  MemoryCandidate,
  MemoryRecord,
  MemoryScope,
  MemoryType,
  MessageRecord,
  RenderedPrompt,
  SearchHit,
  SessionRecord,
  StructuredSummary,
  SummarizeFn,
  SummaryRecord,
} from "./types.js";
import { createVectorStore, type VectorStore } from "./VectorStore.js";

export interface ContextManagerOptions {
  dataDir: string;
  messageThreshold?: number;
  recentMessageCount?: number;
  summarize?: SummarizeFn;
  embeddingService?: EmbeddingService;
  vectorStore?: VectorStore;
  useLanceDb?: boolean;
  largeToolOutputChars?: number;
  memoryExtractor?: IMemoryExtractor;
}

/**
 * M6 门面：消息持久化、摘要压缩、上下文恢复、记忆与检索。
 */
export class ContextManager {
  readonly db: DatabaseManager;
  readonly sessions: SessionStore;
  readonly messages: MessageStore;
  readonly summaries: SummaryStore;
  readonly memories: MemoryStore;
  readonly projects: ProjectStore;
  readonly tasks: TaskStore;
  readonly summaryManager: SummaryManager;
  readonly restorer: ContextRestorer;
  readonly retriever: MemoryRetriever;
  readonly semanticRetriever: SemanticRetriever;
  readonly memoryManager: MemoryManager;
  readonly memoryExtractor: IMemoryExtractor;
  readonly sectionBuilder: SystemSectionBuilder;
  readonly promptBuilder: PromptBuilder;
  readonly embeddings: EmbeddingService;
  readonly vectors: VectorStore;

  private readonly largeToolChars: number;

  constructor(options: ContextManagerOptions) {
    this.db = new DatabaseManager(options.dataDir);
    this.sessions = new SessionStore(this.db);
    this.messages = new MessageStore(this.db);
    this.summaries = new SummaryStore(this.db);
    this.memories = new MemoryStore(this.db);
    this.projects = new ProjectStore(this.db);
    this.tasks = new TaskStore(this.db);
    this.embeddings = options.embeddingService ?? new EmbeddingService(new MockEmbeddingProvider());
    this.vectors =
      options.vectorStore ??
      createVectorStore(options.dataDir, options.useLanceDb !== false);
    this.memoryManager = new MemoryManager(this.memories);
    this.memoryExtractor = options.memoryExtractor ?? new MemoryExtractor();
    this.sectionBuilder = new SystemSectionBuilder();
    this.promptBuilder = new PromptBuilder();
    this.summaryManager = new SummaryManager(this.messages, this.summaries, {
      messageThreshold: options.messageThreshold,
      summarize: options.summarize,
    });
    this.semanticRetriever = new SemanticRetriever(this.db, this.embeddings, this.vectors);
    this.retriever = new MemoryRetriever(
      this.db,
      this.memories,
      this.memoryManager,
      this.embeddings,
      this.vectors,
    );
    this.restorer = new ContextRestorer(
      this.sessions,
      this.messages,
      this.summaries,
      this.projects,
      this.tasks,
      this.retriever,
      this.semanticRetriever,
      this.sectionBuilder,
      this.memoryManager,
      { recentMessageCount: options.recentMessageCount },
    );
    this.largeToolChars = options.largeToolOutputChars ?? 4000;
  }

  createSession(title?: string, projectId?: string): SessionRecord {
    return this.sessions.create(title, projectId);
  }

  createProject(name: string, rootPath?: string, description?: string) {
    return this.projects.create(name, rootPath, description);
  }

  getSession(id: string): SessionRecord | null {
    return this.sessions.get(id);
  }

  listSessions(): SessionRecord[] {
    return this.sessions.list();
  }

  /** @deprecated 请使用 saveUserMessage / saveAssistantMessage / saveToolMessage */
  appendMessage(sessionId: string, role: string, content: string): MessageRecord {
    return this.saveMessage(sessionId, role, content);
  }

  saveUserMessage(sessionId: string, content: string): MessageRecord {
    return this.saveMessage(sessionId, "user", content);
  }

  saveAssistantMessage(sessionId: string, content: string): MessageRecord {
    return this.saveMessage(sessionId, "assistant", content);
  }

  saveToolMessage(sessionId: string, content: string): MessageRecord {
    return this.saveMessage(sessionId, "tool", content);
  }

  private saveMessage(sessionId: string, role: string, content: string): MessageRecord {
    const msg = this.messages.append(sessionId, role, content);
    this.sessions.touch(sessionId, msg.id);
    this.appendMessageLog(sessionId, msg);
    return msg;
  }

  compactToolOutput(tool: string, output: unknown): unknown {
    const json = JSON.stringify(output);
    if (json.length <= this.largeToolChars) return output;
    const summary = json.slice(0, 800);
    return {
      _truncated: true,
      tool,
      preview: `${summary}…`,
      note: "完整输出已截断；如需全文请用 read_file 重新读取对应路径。",
      originalLength: json.length,
    };
  }

  /** 恢复结构化上下文（运行时快照，不持久化 contextPackage 本身）。 */
  async restoreContextPackage(sessionId: string, query?: string): Promise<ContextPackage> {
    this.summaryManager.ensureSessionSummary(sessionId);
    return this.restorer.restore({
      sessionId,
      userInput: query,
    });
  }

  buildChatMessages(
    contextPackage: ContextPackage,
    systemBase: string,
    options?: { phase?: ContextPhase; currentUser?: string },
  ): ChatMessage[] {
    const phase = options?.phase ?? "pre_call";
    return this.promptBuilder.build({
      systemBase,
      systemSections: contextPackage.systemSections,
      messages: contextPackage.messages,
      phase,
      currentUser: phase === "pre_call" ? options?.currentUser : undefined,
    });
  }

  /** 从 contextPackage 生成调试用的渲染结果，不写回 contextPackage。 */
  buildRenderedPrompt(
    contextPackage: ContextPackage,
    systemBase: string,
    options?: { phase?: ContextPhase; currentUser?: string },
  ): RenderedPrompt {
    const phase = options?.phase ?? "pre_call";
    return {
      systemSectionsText: this.promptBuilder.renderSystemSectionsText(
        contextPackage.systemSections,
      ),
      finalMessages: this.buildChatMessages(contextPackage, systemBase, {
        phase,
        currentUser: phase === "pre_call" ? options?.currentUser : undefined,
      }),
    };
  }

  /** 组装带 phase 的调试快照（不持久化）。 */
  async buildContextSnapshot(
    sessionId: string,
    options: {
      phase: ContextPhase;
      userInput?: string;
      systemBase?: string;
      currentUser?: string;
    },
  ): Promise<ContextDebugSnapshot> {
    const contextPackage = await this.restoreContextPackage(sessionId, options.userInput);
    const renderedPrompt = this.buildRenderedPrompt(contextPackage, options.systemBase ?? "", {
      phase: options.phase,
      currentUser: options.phase === "pre_call" ? options.currentUser : undefined,
    });
    return { phase: options.phase, contextPackage, renderedPrompt };
  }

  async finalizeTurn(sessionId: string, query?: string): Promise<{
    compressed: SummaryRecord | null;
    postCall: ContextDebugSnapshot;
  }> {
    await this.extractAndUpsertMemories(sessionId);

    const compressed = await this.summaryManager.compressIfNeeded(sessionId);
    if (compressed) {
      const json = JSON.stringify(compressed.content);
      await this.retriever.indexSummary(
        compressed.id,
        json,
        "session",
        sessionId,
        compressed.content.current_goal,
      );
      const fromSummary = await this.memoryExtractor.extractFromSummary(compressed);
      this.upsertCandidates(fromSummary);
    }
    const postCall = await this.buildContextSnapshot(sessionId, {
      phase: "post_call",
      userInput: query,
    });
    return { compressed, postCall };
  }

  /** 从近期 user 消息与摘要抽取并写入长期记忆（主数据落 SQLite/LanceDB）。 */
  async extractAndUpsertMemories(sessionId: string): Promise<MemoryRecord[]> {
    const recentUsers = this.messages.listRecentByRole(sessionId, "user", 10);
    const candidates = await this.memoryExtractor.extractFromMessages(recentUsers);
    return this.upsertCandidates(candidates);
  }

  private upsertCandidates(candidates: MemoryCandidate[]): MemoryRecord[] {
    return candidates.map((c) =>
      this.upsertMemory({
        scope: c.scope,
        scopeId: c.scopeId,
        memoryType: c.memoryType,
        key: c.key,
        value: c.value,
        summary: c.summary,
        importance: c.importance,
      }),
    );
  }

  upsertMemory(input: {
    scope: MemoryScope;
    scopeId?: string;
    memoryType: MemoryType;
    key?: string;
    value: string;
    summary?: string;
    importance?: number;
  }): MemoryRecord {
    const record = this.memoryManager.upsert(input);
    void this.retriever
      .indexMemory(record.id, record.value, record.scope, record.scopeId, record.summary)
      .catch((error) => {
        this.logContextError("context_index_memory_failed", {
          memoryId: record.id,
          error: String(error),
        });
      });
    return record;
  }

  getMemory(id: string): MemoryRecord | null {
    return this.memories.get(id);
  }

  deactivateMemory(memoryId: string, reason: string): boolean {
    const existing = this.memories.get(memoryId);
    if (!existing?.isActive) return false;
    this.memoryManager.deactivate(memoryId, reason);
    void this.vectors.deleteBySource(memoryId).catch(() => undefined);
    return true;
  }

  listMemories(scope?: MemoryScope, scopeId?: string): MemoryRecord[] {
    if (!scope) {
      return [
        ...this.memories.listActive("global"),
        ...this.memories.listActive("session", scopeId),
      ];
    }
    return this.memories.listActive(scope, scopeId);
  }

  search(query: string, scope?: MemoryScope, scopeId?: string): Promise<SearchHit[]> {
    return this.retriever.search(query, scope, scopeId);
  }

  close(): void {
    this.db.close();
  }

  private appendMessageLog(
    sessionId: string,
    msg: { id: string; role: string; content: string; createdAt: string },
  ): void {
    const logDir = path.join(this.db.filesDir, "..", "logs", "messages");
    mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, `${sessionId}.jsonl`);
    appendFileSync(
      file,
      `${JSON.stringify({ id: msg.id, role: msg.role, content: msg.content, at: msg.createdAt })}\n`,
      "utf-8",
    );
  }

  private logContextError(type: string, data: Record<string, unknown>): void {
    try {
      appendFileSync(
        path.join(this.db.filesDir, "..", "logs", "context-errors.jsonl"),
        `${JSON.stringify(redactValue({ type, ...data, at: new Date().toISOString() }))}\n`,
        "utf-8",
      );
    } catch {
      // 日志写入失败不应影响主请求。
    }
  }
}

/** 用 LLM 生成结构化摘要（供生产环境注入 SummaryManager）。 */
export function createLlmSummarize(
  chat: (prompt: string) => Promise<string>,
): SummarizeFn {
  return async (messages) => {
    const transcript = messages
      .map((m) => `[${m.role}] ${m.content.slice(0, 500)}`)
      .join("\n");
    const prompt = [
      "请将以下对话片段压缩为 JSON 摘要，字段：",
      "current_goal, important_decisions[], user_preferences[], project_state[],",
      "open_questions[], recent_changes[], important_files[], tool_results[], errors_seen[]",
      "只输出 JSON，不要其它文字。",
      "",
      transcript,
    ].join("\n");
    const raw = await chat(prompt);
    try {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start >= 0 && end > start) {
        return JSON.parse(raw.slice(start, end + 1)) as StructuredSummary;
      }
    } catch {
      // fallback
    }
    return { current_goal: raw.slice(0, 300) };
  };
}
