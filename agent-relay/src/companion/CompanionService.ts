import type { ChatRequest, ModelResponse } from "../model/types.js";
import type { RouteOptions } from "../model/routeOptions.js";
import { companionVectorStatus } from "./CompanionVectorIndex.js";
import { CompanionStorageManager } from "./CompanionStorageManager.js";
import { applyCompanionSafety } from "./CompanionSafety.js";
import { composeCompanionMessages } from "./PromptComposer.js";
import { resolvePersona } from "./PersonaRuntime.js";
import type {
  CompanionChatInput,
  CompanionChatResult,
  CompanionMessage,
  CompanionOutputMode,
  CompanionOutputModeInput,
  CompanionSummary,
} from "./types.js";

export interface CompanionServiceDeps {
  projectRoot: string;
  directChat: (request: ChatRequest, opts?: RouteOptions) => Promise<ModelResponse>;
}

export class CompanionService {
  readonly storageManager: CompanionStorageManager;

  constructor(private readonly deps: CompanionServiceDeps) {
    this.storageManager = new CompanionStorageManager(deps.projectRoot);
  }

  storageStatus(storageRoot?: string) {
    return this.storageManager.get(storageRoot).status();
  }

  vectorStatus(storageRoot?: string) {
    const storage = this.storageManager.get(storageRoot);
    return companionVectorStatus(storage.storageRoot);
  }

  listSessions(storageRoot?: string) {
    const storage = this.storageManager.get(storageRoot);
    return {
      storage: storage.status(),
      sessions: storage.listSessions(),
    };
  }

  createSession(input?: { storageRoot?: string; personaId?: string; title?: string }) {
    const storage = this.storageManager.get(input?.storageRoot);
    return {
      storage: storage.status(),
      session: storage.createSession({
        personaId: input?.personaId,
        title: input?.title,
      }),
    };
  }

  listMessages(input: { storageRoot?: string; sessionId: string; limit?: number }) {
    const storage = this.storageManager.get(input.storageRoot);
    const session = storage.getSession(input.sessionId);
    if (!session) return null;
    return {
      storage: storage.status(),
      session,
      messages: storage.listMessages(input.sessionId, input.limit ?? 100),
      summaries: storage.listSummaries(input.sessionId),
    };
  }

  async chat(input: CompanionChatInput): Promise<CompanionChatResult> {
    const message = (input.message ?? "").trim();
    if (!message) throw new Error("message 不能为空");

    const storage = this.storageManager.get(input.storageRoot);
    const persona = resolvePersona(input.personaId);
    const incognito = input.incognito === true;
    const outputMode = normalizeOutputMode(input.outputMode);
    const session = incognito
      ? undefined
      : input.sessionId
        ? storage.getSession(input.sessionId) ?? storage.createSession({ id: input.sessionId, personaId: persona.id })
        : storage.createSession({ personaId: persona.id, title: message.slice(0, 40) || "纯聊天会话" });

    const userMessage = session
      ? storage.createMessage({
          sessionId: session.id,
          role: "user",
          content: message,
          memoryEligible: false,
          metadata: modeMetadata(outputMode),
        })
      : undefined;

    const recent = session ? storage.listMessages(session.id, 30) : [];
    const summaries = session ? filterSummariesForMode(storage.listSummaries(session.id, 24), outputMode).slice(-6) : [];
    const request = {
      messages: composeCompanionMessages({
        persona,
        currentUserMessage: message,
        recentMessages: filterMessagesForMode(
          recent.filter((m) => m.id !== userMessage?.id),
          outputMode,
        ),
        summaries,
        outputMode,
      }),
      temperature: 0.7,
    } satisfies ChatRequest;

    const response = await this.deps.directChat(request, {
      forceClient: input.clientName && input.clientName !== "__default__" ? input.clientName : undefined,
      taskType: "simple",
    });
    const rawContent = response.content;
    const safety = applyCompanionSafety({ userText: message, assistantText: rawContent, outputMode });
    const assistantMessage = session
      ? storage.createMessage({
          sessionId: session.id,
          role: "assistant",
          content: safety.content,
          modelName: response.modelName,
          clientName: response.clientName,
          metadata: { latencyMs: response.latencyMs, usage: response.usage, safety, ...modeMetadata(outputMode) },
        })
      : undefined;

    const summaryStatus = session
      ? await this.maybeSummarize(storage, session.id, response.modelName, false, outputMode)
      : { generated: false, reason: "incognito" };
    const refreshedSession = session ? storage.getSession(session.id) ?? session : undefined;
    return {
      session: refreshedSession,
      userMessage,
      assistantMessage: assistantMessage ?? undefined,
      content: safety.content,
      storage: storage.status(),
      safety,
      summaryStatus,
      vector: companionVectorStatus(storage.storageRoot),
    };
  }

  async summarize(input: {
    storageRoot?: string;
    sessionId: string;
    force?: boolean;
    outputMode?: CompanionOutputModeInput;
  }) {
    const storage = this.storageManager.get(input.storageRoot);
    const session = storage.getSession(input.sessionId);
    if (!session) return null;
    const outputMode = normalizeOutputMode(input.outputMode);
    return {
      storage: storage.status(),
      session,
      summaryStatus: await this.maybeSummarize(storage, input.sessionId, undefined, input.force === true, outputMode),
      summaries: storage.listSummaries(input.sessionId),
    };
  }

  async chatStream(
    input: CompanionChatInput,
    emit: (event: Record<string, unknown> & { type: string }) => void,
  ): Promise<void> {
    const message = (input.message ?? "").trim();
    if (!message) throw new Error("message 不能为空");
    const storage = this.storageManager.get(input.storageRoot);
    const persona = resolvePersona(input.personaId);
    const incognito = input.incognito === true;
    const outputMode = normalizeOutputMode(input.outputMode);
    const session = incognito
      ? undefined
      : input.sessionId
        ? storage.getSession(input.sessionId) ?? storage.createSession({ id: input.sessionId, personaId: persona.id })
        : storage.createSession({ personaId: persona.id, title: message.slice(0, 40) || "纯聊天会话" });
    const userMessage = session
      ? storage.createMessage({
          sessionId: session.id,
          role: "user",
          content: message,
          memoryEligible: false,
          metadata: modeMetadata(outputMode),
        })
      : undefined;
    const assistantDraft = session
      ? storage.createMessage({
          sessionId: session.id,
          role: "assistant",
          content: "",
          status: "streaming",
          memoryEligible: false,
          metadata: modeMetadata(outputMode),
        })
      : undefined;
    emit({ type: "run_start", session, userMessage, assistantMessage: assistantDraft, storage: storage.status() });

    let streamed = "";
    try {
      const recent = session ? storage.listMessages(session.id, 30) : [];
      const summaries = session ? filterSummariesForMode(storage.listSummaries(session.id, 24), outputMode).slice(-6) : [];
      const response = await this.deps.directChat(
        {
          messages: composeCompanionMessages({
            persona,
            currentUserMessage: message,
            recentMessages: filterMessagesForMode(
              recent.filter((m) => m.id !== userMessage?.id && m.id !== assistantDraft?.id),
              outputMode,
            ),
            summaries,
            outputMode,
          }),
          temperature: 0.7,
          onToken: (delta) => {
            streamed += delta;
          },
        },
        {
          forceClient: input.clientName && input.clientName !== "__default__" ? input.clientName : undefined,
          taskType: "simple",
        },
      );
      const raw = streamed || response.content;
      const safety = applyCompanionSafety({ userText: message, assistantText: raw, outputMode });
      emitSanitizedTokens(safety.content, emit);
      const assistantMessage = assistantDraft
        ? storage.updateMessage(assistantDraft.id, {
            content: safety.content,
            status: "completed",
            modelName: response.modelName,
            clientName: response.clientName,
            metadata: { latencyMs: response.latencyMs, usage: response.usage, safety, ...modeMetadata(outputMode) },
          })
        : undefined;
      const summaryStatus = session
        ? await this.maybeSummarize(storage, session.id, response.modelName, false, outputMode)
        : { generated: false, reason: "incognito" };
      emit({
        type: "done",
        session: session ? storage.getSession(session.id) : undefined,
        userMessage,
        assistantMessage,
        content: safety.content,
        safety,
        storage: storage.status(),
        summaryStatus,
        vector: companionVectorStatus(storage.storageRoot),
      });
    } catch (error) {
      if (assistantDraft) {
        const partialSafety = applyCompanionSafety({ userText: message, assistantText: streamed, outputMode });
        storage.updateMessage(assistantDraft.id, {
          content: partialSafety.content,
          status: "interrupted",
          metadata: { error: String(error), safety: partialSafety, interruptedRawLength: streamed.length, ...modeMetadata(outputMode) },
        });
      }
      emit({ type: "error", error: String(error), storage: storage.status() });
    }
  }

  close(): void {
    this.storageManager.closeAll();
  }

  private async maybeSummarize(
    storage: ReturnType<CompanionStorageManager["get"]>,
    sessionId: string,
    modelName?: string,
    force = false,
    outputMode: CompanionOutputMode = "bounded",
  ): Promise<{ generated: boolean; summaryId?: string; reason?: string }> {
    const messages = storage.listMessages(sessionId, 200);
    const completed = filterMessagesForMode(
      messages.filter((m) => m.status === "completed"),
      outputMode,
    );
    if (!force && completed.length < 16) return { generated: false, reason: "not_enough_messages" };
    const summaries = filterSummariesForMode(storage.listSummaries(sessionId, 200), outputMode);
    const lastSummary = summaries[summaries.length - 1];
    const lastSummaryIndex = lastSummary ? completed.findIndex((m) => m.id === lastSummary.sourceMessageEndId) : -1;
    const sourceStart = lastSummaryIndex + 1;
    const sourceEnd = force ? completed.length : Math.max(sourceStart, completed.length - 8);
    const source = completed.slice(sourceStart, sourceEnd);
    if (source.length < 4) return { generated: false, reason: "not_enough_unsummarized_messages" };
    const summary = buildExtractiveSummary(source.map((m) => `${m.role}: ${m.content}`));
    const first = source[0];
    const last = source[source.length - 1];
    if (!first || !last) return { generated: false, reason: "empty_source" };
    const record = storage.createSummary({
      sessionId,
      sourceMessageStartId: first.id,
      sourceMessageEndId: last.id,
      summary,
      topics: [...extractTopics(summary), `mode:${outputMode}`],
      modelName,
    });
    return { generated: true, summaryId: record.id };
  }
}

function normalizeOutputMode(mode?: CompanionOutputModeInput): CompanionOutputMode {
  return mode === "unrestricted" || mode === "raw" ? "unrestricted" : "bounded";
}

function modeMetadata(outputMode: CompanionOutputMode): Record<string, unknown> {
  return {
    outputMode,
    companionMode: outputMode,
    boundaryAudit: outputMode === "unrestricted",
  };
}

function emitSanitizedTokens(
  content: string,
  emit: (event: Record<string, unknown> & { type: string }) => void,
): void {
  for (let i = 0; i < content.length; i += 24) {
    emit({ type: "token", delta: content.slice(i, i + 24) });
  }
}

function messageMode(message: CompanionMessage): CompanionOutputMode {
  const raw = message.metadata?.outputMode ?? message.metadata?.companionMode;
  return raw === "unrestricted" || raw === "raw" ? "unrestricted" : "bounded";
}

function filterMessagesForMode(messages: CompanionMessage[], outputMode: CompanionOutputMode): CompanionMessage[] {
  if (outputMode === "unrestricted") return messages;
  return messages.filter((message) => messageMode(message) !== "unrestricted");
}

function summaryMode(summary: CompanionSummary): CompanionOutputMode {
  return summary.topics.includes("mode:unrestricted") ? "unrestricted" : "bounded";
}

function filterSummariesForMode(summaries: CompanionSummary[], outputMode: CompanionOutputMode): CompanionSummary[] {
  if (outputMode === "unrestricted") return summaries;
  return summaries.filter((summary) => summaryMode(summary) !== "unrestricted");
}

function buildExtractiveSummary(lines: string[]): string {
  const joined = lines.join("\n").replace(/\s+/g, " ").trim();
  const clipped = joined.length > 700 ? `${joined.slice(0, 700)}...` : joined;
  return `这段较早对话的关键内容：${clipped}`;
}

function extractTopics(summary: string): string[] {
  const topics = ["聊天"];
  if (/工作|项目|代码|任务/.test(summary)) topics.push("工作");
  if (/难过|焦虑|孤独|情绪/.test(summary)) topics.push("情绪");
  if (/现实|朋友|家人|作息/.test(summary)) topics.push("现实支持");
  return [...new Set(topics)];
}
