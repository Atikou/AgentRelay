import type { AgentNotification } from "../background/types.js";
import type { NotificationQueue } from "../background/NotificationQueue.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { ChatMessage, ChatRequest, ModelResponse } from "../model/types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import { wrapUntrustedToolOutput } from "../util/injection.js";
import { CONFIRMATION_REQUIRED, MODE_PERMISSIONS, type ToolPermission } from "./permissions.js";

export type LoopChatFn = (
  req: ChatRequest,
  opts?: { sensitive?: boolean },
) => Promise<ModelResponse>;

/** 一次工具调用的记录（用于回显执行过程）。 */
export interface AgentToolStep {
  iteration: number;
  tool: string;
  input: unknown;
  thought?: string;
  ok: boolean;
  output?: unknown;
  error?: string;
  durationMs?: number;
  blocked?: boolean;
}

export interface AgentRunResult {
  answer: string;
  steps: AgentToolStep[];
  iterations: number;
  /** 因达到迭代上限而未给出 final 答案时为 true。 */
  reachedLimit: boolean;
  /** 本轮在安全点消费的系统通知（如后台任务完成）。 */
  notifications?: AgentNotification[];
  /** M6：持久化会话 id（启用 ContextManager 时返回）。 */
  sessionId?: string;
  /** M6：本轮是否触发了历史压缩。 */
  compressed?: boolean;
}

export interface AgentLoopOptions {
  chat: LoopChatFn;
  registry: ToolRegistry;
  workspaceRoot: string;
  /** 暴露给模型/可执行的权限集，默认任务模式全集。 */
  allowedPermissions?: ToolPermission[];
  maxIterations?: number;
  /** 自动确认副作用工具（写/命令/联网/危险）。false 时这些工具会被阻塞。 */
  autoConfirm?: boolean;
  sensitive?: boolean;
  trace?: TraceLogger;
  /** 每发生一步工具调用时回调（便于流式回显）。 */
  onStep?: (step: AgentToolStep) => void;
  /** 通知队列：仅在安全点 drain 后注入上下文。 */
  notificationQueue?: NotificationQueue;
  /** M6：上下文压缩与持久化（可选）。 */
  contextManager?: ContextManager;
  /** M6：已有会话 id；未提供时自动创建。 */
  sessionId?: string;
}

interface ToolAction {
  action: "tool";
  tool: string;
  input?: Record<string, unknown>;
  thought?: string;
}
interface FinalAction {
  action: "final";
  answer: string;
}
type AgentAction = ToolAction | FinalAction;

/**
 * 基础 Agent 对话循环（M1）。
 *
 * 采用可移植的 ReAct 风格 JSON 协议：模型每轮只输出一个 JSON——要么请求调用一个工具，
 * 要么给出最终答案。工具经 ToolRegistry 执行（含校验/权限/风险/超时），结果回灌给模型继续推理。
 * 不依赖各后端的原生 function-calling，本地与远程模型均可用。
 */
export class AgentLoop {
  private readonly allowed: ToolPermission[];
  private readonly maxIterations: number;

  constructor(private readonly options: AgentLoopOptions) {
    this.allowed = options.allowedPermissions ?? MODE_PERMISSIONS.task;
    this.maxIterations = options.maxIterations ?? 8;
  }

  async run(userMessage: string, system?: string): Promise<AgentRunResult> {
    const ctx = this.options.contextManager;
    let sessionId = this.options.sessionId;
    if (ctx && !sessionId) {
      sessionId = ctx.createSession().id;
    }
    if (ctx && sessionId) {
      ctx.saveUserMessage(sessionId, userMessage);
    }

    const messages: ChatMessage[] = ctx && sessionId
      ? ctx.buildChatMessages(
          await ctx.restoreContextPackage(sessionId, userMessage),
          this.buildSystemPrompt(system),
          { phase: "pre_call", currentUser: userMessage },
        )
      : [
          { role: "system", content: this.buildSystemPrompt(system) },
          { role: "user", content: userMessage },
        ];
    const steps: AgentToolStep[] = [];
    const consumedNotifications: AgentNotification[] = [];

    const injectNotifications = () => {
      const notes = this.drainNotifications();
      if (notes.length === 0) return;
      consumedNotifications.push(...notes);
      messages.push({ role: "user", content: renderNotifications(notes) });
    };

    injectNotifications();

    for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
      const response = await this.options.chat(
        { messages, temperature: 0.2 },
        { sensitive: this.options.sensitive },
      );
      messages.push({ role: "assistant", content: response.content });
      if (ctx && sessionId) {
        ctx.saveAssistantMessage(sessionId, response.content);
      }

      const action = parseAction(response.content);
      if (!action) {
        messages.push({
          role: "user",
          content: '上一条不是合法的 JSON。请只输出一个 JSON 对象：{"action":"tool",...} 或 {"action":"final","answer":"..."}。',
        });
        continue;
      }

      if (action.action === "final") {
        return await this.finishRun({
          answer: action.answer,
          steps,
          iterations: iteration,
          reachedLimit: false,
          consumedNotifications,
          sessionId,
          userMessage,
        });
      }

      // 工具调用
      const step = await this.runToolAction(action, iteration);
      steps.push(step);
      this.options.onStep?.(step);
      const toolText = this.renderToolResult(step);
      messages.push({ role: "user", content: toolText });
      if (ctx && sessionId) {
        ctx.saveToolMessage(sessionId, toolText);
      }
      injectNotifications();
    }

    return await this.finishRun({
      answer: "（已达到最大迭代步数，未得到最终答案）",
      steps,
      iterations: this.maxIterations,
      reachedLimit: true,
      consumedNotifications,
      sessionId,
      userMessage,
    });
  }

  private async finishRun(input: {
    answer: string;
    steps: AgentToolStep[];
    iterations: number;
    reachedLimit: boolean;
    consumedNotifications: AgentNotification[];
    sessionId?: string;
    userMessage: string;
  }): Promise<AgentRunResult> {
    const ctx = this.options.contextManager;
    let compressed = false;
    if (ctx && input.sessionId) {
      const result = await ctx.finalizeTurn(input.sessionId, input.userMessage);
      compressed = result.compressed !== null;
    }
    return {
      answer: input.answer,
      steps: input.steps,
      iterations: input.iterations,
      reachedLimit: input.reachedLimit,
      notifications: input.consumedNotifications.length
        ? input.consumedNotifications
        : undefined,
      sessionId: input.sessionId,
      compressed: compressed || undefined,
    };
  }

  private drainNotifications(): AgentNotification[] {
    return this.options.notificationQueue?.drain() ?? [];
  }

  private async runToolAction(action: ToolAction, iteration: number): Promise<AgentToolStep> {
    const base: AgentToolStep = {
      iteration,
      tool: action.tool,
      input: action.input ?? {},
      thought: action.thought,
      ok: false,
    };

    const tool = this.options.registry.get(action.tool);
    if (!tool) {
      return { ...base, error: `未知工具：${action.tool}` };
    }

    if (!this.allowed.includes(tool.permission)) {
      return { ...base, blocked: true, error: `当前模式不允许的权限：${tool.permission}` };
    }

    // 副作用/高风险工具：未自动确认则阻塞（在非交互的循环里更安全）。
    if (CONFIRMATION_REQUIRED.includes(tool.permission) && !this.options.autoConfirm) {
      return {
        ...base,
        blocked: true,
        error: `工具「${tool.name}」需要确认（权限 ${tool.permission}）。未开启自动确认，已跳过。`,
      };
    }

    this.options.trace?.write({ type: "agent_tool", tool: action.tool, iteration });
    const result = await this.options.registry.run(action.tool, action.input ?? {}, {
      workspaceRoot: this.options.workspaceRoot,
      allowedPermissions: this.allowed,
    });

    if (result.ok) {
      const output =
        this.options.contextManager?.compactToolOutput(action.tool, result.output) ??
        result.output;
      return { ...base, ok: true, output, durationMs: result.durationMs };
    }
    return { ...base, error: `[${result.code}] ${result.error}`, durationMs: result.durationMs };
  }

  private renderToolResult(step: AgentToolStep): string {
    if (step.blocked) {
      return `工具「${step.tool}」未执行：${step.error}。请改用其它只读工具，或直接给出 final 答案。`;
    }
    if (!step.ok) {
      return `工具「${step.tool}」执行失败：${step.error}。请据此调整下一步。`;
    }
    const compacted =
      this.options.contextManager?.compactToolOutput(step.tool, step.output) ?? step.output;
    const wrapped = wrapUntrustedToolOutput(step.tool, compacted);
    const json = JSON.stringify(wrapped);
    const body = json.length > 4000 ? `${json.slice(0, 4000)}…(已截断)` : json;
    return `工具「${step.tool}」执行结果（JSON）：\n${body}`;
  }

  private buildSystemPrompt(extra?: string): string {
    const specs = this.options.registry
      .list()
      .filter((t) => this.allowed.includes(t.permission))
      .map((t) => {
        const side = t.hasSideEffect ? " [副作用]" : "";
        return `- ${t.name}(${t.inputHint ?? ""}) [权限:${t.permission}]${side}：${t.description}`;
      })
      .join("\n");

    return [
      "你是一个本地优先的编程助手，可以使用工具读取/搜索/修改工作区文件、执行命令来完成用户任务。",
      "",
      "可用工具：",
      specs,
      "",
      "严格遵守以下协议：",
      '1. 每次回复必须且只能输出一个 JSON 对象，禁止输出 JSON 以外的任何文字或 Markdown 代码围栏。',
      '2. 需要使用工具时输出：{"action":"tool","tool":"工具名","input":{参数},"thought":"简述原因"}',
      '3. 已能回答用户时输出：{"action":"final","answer":"给用户的最终中文回答"}',
      "4. 一次只能调用一个工具；根据工具返回结果再决定下一步。",
      "5. 不要臆测文件内容或命令输出，先用工具查看再下结论。",
      extra ? `\n补充要求：${extra}` : "",
    ].join("\n");
  }
}

/** 将安全点消费的通知格式化为可回灌给模型的用户消息。 */
export function renderNotifications(notes: AgentNotification[]): string {
  const lines = notes.map(
    (n) => `- [${n.source}/${n.level}] ${n.timestamp}: ${n.message}`,
  );
  return [
    "系统通知（后台任务等，已在安全点注入，请勿打断当前工具链）：",
    ...lines,
    "请酌情纳入下一步推理；若与当前任务无关可忽略。",
  ].join("\n");
}

/** 去掉思考块、围栏等噪声，便于从小模型输出中提取 JSON。 */
export function stripModelNoise(content: string): string {
  let s = content;
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/<redacted_reasoning>[\s\S]*?<\/redacted_reasoning>/gi, "");
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  return s.trim();
}

/** 从模型输出中提取第一个平衡的 JSON 对象并解析为动作。 */
export function parseAction(content: string): AgentAction | null {
  const obj = extractFirstJsonObject(stripModelNoise(content));
  if (!obj) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(obj);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (p.action === "final" && typeof p.answer === "string") {
    return { action: "final", answer: p.answer };
  }
  if (p.action === "tool" && typeof p.tool === "string") {
    return {
      action: "tool",
      tool: p.tool,
      input: (p.input as Record<string, unknown>) ?? {},
      thought: typeof p.thought === "string" ? p.thought : undefined,
    };
  }
  return null;
}

/** 扫描出首个平衡的 {...}（忽略字符串内的花括号）。 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
