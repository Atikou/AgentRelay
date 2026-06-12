import type { AgentNotification } from "../background/types.js";
import { readMergeCount } from "../background/NotificationQueue.js";
import type { NotificationQueue } from "../background/NotificationQueue.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { ModelTaskType } from "../model/taskType.js";
import type { ChatMessage, ChatRequest, ModelResponse } from "../model/types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { AgentStepPlan } from "../plan/types.js";
import { wrapUntrustedToolOutput } from "../util/injection.js";
import { redactPreview } from "../util/redact.js";
import { PlanWorkflow, type PlanWorkflowResult } from "./PlanWorkflow.js";
import { CONFIRMATION_REQUIRED, MODE_PERMISSIONS, type ToolPermission } from "./permissions.js";
import {
  resolveRunPolicy,
  type AgentExecutionMeta,
  type AgentRunMode,
  type AgentStopReason,
  type LocationExecutionMeta,
  type RunBudget,
  type RunBudgetKey,
  type RunBudgetUsage,
  type RunPolicy,
} from "./RunPolicy.js";

export type LoopChatFn = (
  req: ChatRequest,
  opts?: { sensitive?: boolean; taskType?: ModelTaskType },
) => Promise<ModelResponse>;

/** 一次工具调用的记录（用于回显执行过程）。 */
export interface AgentToolStep {
  iteration: number;
  toolCallId?: string;
  tool: string;
  input: unknown;
  permission?: ToolPermission;
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
  /** 因达到运行预算而未给出 final 答案时为 true。 */
  reachedLimit: boolean;
  /** 本次运行实际生效的模式、预算、调用计数与停止原因。 */
  executionMeta: AgentExecutionMeta;
  /** 本轮在安全点消费的系统通知（如后台任务完成）。 */
  notifications?: AgentNotification[];
  /** M6：持久化会话 id（启用 ContextManager 时返回）。 */
  sessionId?: string;
  /** M6：本轮是否触发了历史压缩。 */
  compressed?: boolean;
}

interface AgentModelTurnMetric {
  iteration: number;
  success: boolean;
  client?: string;
  model?: string;
  location?: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  error?: string;
}

export interface AgentLoopOptions {
  chat: LoopChatFn;
  registry: ToolRegistry;
  workspaceRoot: string;
  /** 暴露给模型/可执行的权限集，默认任务模式全集。 */
  allowedPermissions?: ToolPermission[];
  /** 运行模式；未传时可由上层 RunPolicy 推断，默认 chat。 */
  mode?: AgentRunMode;
  /** 上层解析好的运行策略。 */
  policy?: RunPolicy;
  budget?: Partial<RunBudget>;
  /** 自动确认副作用工具（写/命令/联网/危险）。false 时这些工具会被阻塞。 */
  autoConfirm?: boolean;
  sensitive?: boolean;
  taskType?: ModelTaskType;
  trace?: TraceLogger;
  /** 每发生一步工具调用时回调（便于流式回显）。 */
  onStep?: (step: AgentToolStep) => void;
  /** 通知队列：仅在安全点 drain 后注入上下文。 */
  notificationQueue?: NotificationQueue;
  /** M6：上下文压缩与持久化（可选）。 */
  contextManager?: ContextManager;
  /** M6：已有会话 id；未提供时自动创建。 */
  sessionId?: string;
  /** 编排 Run id，写入 trace 与工具审计。 */
  runId?: string;
  taskId?: string;
  requestId?: string;
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
  private readonly budget: RunBudget;
  private readonly policy: RunPolicy;
  private runStartedAt = 0;
  private modelTurnMetrics: AgentModelTurnMetric[] = [];

  constructor(private readonly options: AgentLoopOptions) {
    this.policy =
      options.policy ??
      resolveRunPolicy({
        requestedMode: options.mode,
        budget: options.budget,
        taskType: options.taskType,
      });
    this.allowed = options.allowedPermissions ?? this.policy.allowedPermissions ?? MODE_PERMISSIONS.task;
    this.budget = this.policy.budget;
  }

  async run(userMessage: string, system?: string): Promise<AgentRunResult> {
    this.runStartedAt = Date.now();
    this.modelTurnMetrics = [];
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
      const rendered = renderNotifications(notes);
      const wrapped = wrapUntrustedToolOutput("notification", rendered);
      messages.push({
        role: "user",
        content: typeof wrapped === "string" ? wrapped : JSON.stringify(wrapped),
      });
    };

    injectNotifications();

    const workflow = await this.runPlanWorkflow(userMessage);
    if (workflow) {
      steps.push(...workflow.steps);
      for (const step of workflow.steps) this.options.onStep?.(step);
      messages.push({ role: "user", content: workflow.modelContext });
    }

    let modelTurns = 0;
    while (modelTurns < this.budget.maxModelTurns) {
      const runtimeExhausted = this.findRuntimeBudgetExhaustion();
      if (runtimeExhausted) {
        return await this.finishRun({
          answer: this.buildPartialFinalAnswer(steps, runtimeExhausted),
          steps,
          iterations: modelTurns,
          reachedLimit: true,
          budgetExhausted: runtimeExhausted,
          consumedNotifications,
          sessionId,
          userMessage,
        });
      }

      const iteration = modelTurns + 1;
      modelTurns = iteration;
      const modelStart = Date.now();
      let response: ModelResponse;
      try {
        response = await this.options.chat(
          { messages, temperature: 0.2 },
          { sensitive: this.options.sensitive, taskType: this.options.taskType },
        );
        this.recordModelTurn({
          iteration,
          success: true,
          client: response.clientName,
          model: response.modelName,
          location: response.location,
          latencyMs: Math.round(response.latencyMs || Date.now() - modelStart),
          inputTokens: response.usage?.inputTokens,
          outputTokens: response.usage?.outputTokens,
          costUsd: response.costUsd,
        });
      } catch (error) {
        this.recordModelTurn({
          iteration,
          success: false,
          latencyMs: Date.now() - modelStart,
          error: String(error),
        });
        throw error;
      }
      messages.push({ role: "assistant", content: response.content });
      if (ctx && sessionId) {
        ctx.saveAssistantMessage(sessionId, response.content);
      }

      const action = parseAction(response.content);
      if (!action) {
        this.writeAgentDecisionTrace({
          iteration,
          action: "parse_error",
          rawPreview: redactPreview(response.content, 300),
        });
        messages.push({
          role: "user",
          content: '上一条不是合法的 JSON。请只输出一个 JSON 对象：{"action":"tool",...} 或 {"action":"final","answer":"..."}。',
        });
        continue;
      }

      if (action.action === "final") {
        this.writeAgentDecisionTrace({
          iteration,
          action: "final",
          answerLength: action.answer.length,
        });
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
      const toolCallId = this.makeToolCallId(iteration, action.tool);
      this.writeAgentDecisionTrace({
        iteration,
        action: "tool",
        tool: action.tool,
        toolCallId,
        thought: action.thought,
        inputPreview: redactPreview(action.input ?? {}, 500),
      });
      const toolBudgetExhausted = this.findToolBudgetExhaustion(action, steps);
      if (toolBudgetExhausted) {
        const step = this.buildBudgetBlockedStep(action, iteration, toolBudgetExhausted, toolCallId);
        steps.push(step);
        this.options.onStep?.(step);
        return await this.finishRun({
          answer: this.buildPartialFinalAnswer(steps, toolBudgetExhausted),
          steps,
          iterations: modelTurns,
          reachedLimit: true,
          budgetExhausted: toolBudgetExhausted,
          consumedNotifications,
          sessionId,
          userMessage,
        });
      }
      const step = await this.runToolAction(action, iteration, toolCallId);
      steps.push(step);
      this.options.onStep?.(step);
      const toolText = this.renderToolResult(step);
      messages.push({ role: "user", content: toolText });
      if (ctx && sessionId) {
        ctx.saveToolMessage(sessionId, toolText);
      }
      injectNotifications();

      const postToolRuntimeExhausted = this.findRuntimeBudgetExhaustion();
      if (postToolRuntimeExhausted) {
        return await this.finishRun({
          answer: this.buildPartialFinalAnswer(steps, postToolRuntimeExhausted),
          steps,
          iterations: modelTurns,
          reachedLimit: true,
          budgetExhausted: postToolRuntimeExhausted,
          consumedNotifications,
          sessionId,
          userMessage,
        });
      }
    }

    return await this.finishRun({
      answer: this.buildPartialFinalAnswer(steps, "maxModelTurns"),
      steps,
      iterations: modelTurns,
      reachedLimit: true,
      budgetExhausted: "maxModelTurns",
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
    budgetExhausted?: RunBudgetKey;
    consumedNotifications: AgentNotification[];
    sessionId?: string;
    userMessage: string;
  }): Promise<AgentRunResult> {
    this.writeAgentStepPlanTrace(input.steps);
    const ctx = this.options.contextManager;
    let compressed = false;
    if (ctx && input.sessionId) {
      const result = await ctx.finalizeTurn(input.sessionId, input.userMessage);
      compressed = result.compressed !== null;
    }
    const executionMeta = this.buildExecutionMeta({
      steps: input.steps,
      iterations: input.iterations,
      stopReason: input.reachedLimit ? "budget_exhausted" : "completed",
      budgetExhausted: input.budgetExhausted,
    });
    this.writeRunUsageSummary(input.steps, executionMeta);
    return {
      answer: input.answer,
      steps: input.steps,
      iterations: input.iterations,
      reachedLimit: input.reachedLimit,
      executionMeta,
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

  private runPlanWorkflow(userMessage: string): Promise<PlanWorkflowResult | undefined> {
    return new PlanWorkflow({
      registry: this.options.registry,
      workspaceRoot: this.options.workspaceRoot,
      allowedPermissions: this.allowed,
      budget: this.budget,
      trace: this.options.trace,
      contextManager: this.options.contextManager,
      sessionId: this.options.sessionId,
      taskId: this.options.taskId,
      requestId: this.options.requestId ?? this.options.runId,
    }).run(userMessage, this.policy.mode);
  }

  private async runToolAction(
    action: ToolAction,
    iteration: number,
    toolCallId: string,
  ): Promise<AgentToolStep> {
    const base: AgentToolStep = {
      iteration,
      toolCallId,
      tool: action.tool,
      input: action.input ?? {},
      thought: action.thought,
      ok: false,
    };

    const tool = this.options.registry.get(action.tool);
    if (!tool) {
      return { ...base, error: `未知工具：${action.tool}` };
    }
    const withPermission = { ...base, permission: tool.permission };

    if (!this.allowed.includes(tool.permission)) {
      return { ...withPermission, blocked: true, error: `当前模式不允许的权限：${tool.permission}` };
    }

    // 副作用/高风险工具：未自动确认则阻塞（在非交互的循环里更安全）。
    if (CONFIRMATION_REQUIRED.includes(tool.permission) && !this.options.autoConfirm) {
      return {
        ...withPermission,
        blocked: true,
        error: `工具「${tool.name}」需要确认（权限 ${tool.permission}）。未开启自动确认，已跳过。`,
      };
    }

    this.options.trace?.write({
      type: "agent_tool",
      tool: action.tool,
      iteration,
      toolCallId,
      runId: this.options.runId,
      sessionId: this.options.sessionId,
      taskId: this.options.taskId,
    });
    const result = await this.options.registry.run(action.tool, action.input ?? {}, {
      workspaceRoot: this.options.workspaceRoot,
      allowedPermissions: this.allowed,
      taskId: this.options.taskId,
      sessionId: this.options.sessionId,
      requestId: this.options.requestId ?? this.options.runId,
      toolCallId,
    });

    if (result.ok) {
      const output =
        this.options.contextManager?.compactToolOutput(action.tool, result.output) ??
        result.output;
      return { ...withPermission, ok: true, output, durationMs: result.durationMs, toolCallId: result.toolCallId };
    }
    return {
      ...withPermission,
      error: `[${result.code}] ${result.error}`,
      durationMs: result.durationMs,
      toolCallId: result.toolCallId,
    };
  }

  private findRuntimeBudgetExhaustion(): RunBudgetKey | undefined {
    if (Date.now() - this.runStartedAt >= this.budget.maxRuntimeMs) return "maxRuntimeMs";
    return undefined;
  }

  private findToolBudgetExhaustion(action: ToolAction, steps: AgentToolStep[]): RunBudgetKey | undefined {
    if (steps.length >= this.budget.maxToolCalls) return "maxToolCalls";
    const tool = this.options.registry.get(action.tool);
    if (!tool) return undefined;
    if (!this.allowed.includes(tool.permission)) return undefined;
    const usage = this.countSuccessfulPermissionUsage(steps);
    if (tool.permission === "read" && usage.readCalls >= this.budget.maxReadCalls) return "maxReadCalls";
    if (
      (tool.permission === "write" || tool.permission === "dangerous") &&
      usage.writeCalls >= this.budget.maxWriteCalls
    ) {
      return "maxWriteCalls";
    }
    if (tool.permission === "shell" && usage.shellCalls >= this.budget.maxShellCalls) return "maxShellCalls";
    return undefined;
  }

  private buildBudgetBlockedStep(
    action: ToolAction,
    iteration: number,
    budgetExhausted: RunBudgetKey,
    toolCallId?: string,
  ): AgentToolStep {
    const tool = this.options.registry.get(action.tool);
    return {
      iteration,
      toolCallId,
      tool: action.tool,
      input: action.input ?? {},
      permission: tool?.permission,
      thought: action.thought,
      ok: false,
      blocked: true,
      error: `运行预算已耗尽：${budgetExhausted}`,
    };
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
      "6. 需要查找相关文件时，优先使用 project_scan / locate_relevant_files / context_pack；避免连续用 list_files、search_text、read_file 逐个试探。",
      "7. locate_relevant_files 已返回 primaryFiles 时，优先用 context_pack 打包这些文件，再分析或修改。",
      this.policy.systemHint,
      extra ? `\n补充要求：${extra}` : "",
    ].join("\n");
  }

  private buildExecutionMeta(input: {
    steps: AgentToolStep[];
    iterations: number;
    stopReason: AgentStopReason;
    budgetExhausted?: RunBudgetKey;
  }): AgentExecutionMeta {
    const usage = this.buildBudgetUsage(input.steps, input.iterations);
    const needsMoreBudget = input.stopReason === "budget_exhausted";
    return {
      mode: this.policy.mode,
      budget: this.budget,
      usage,
      budgetExhausted: input.budgetExhausted,
      usedIterations: input.iterations,
      usedModelTurns: input.iterations,
      usedToolCalls: usage.toolCalls,
      usedReadCalls: usage.readCalls,
      usedWriteCalls: usage.writeCalls,
      usedShellCalls: usage.shellCalls,
      stopReason: input.stopReason,
      needsMoreBudget,
      location: this.buildLocationMeta(input.steps),
      suggestedBudget: needsMoreBudget ? this.buildSuggestedBudget(input.budgetExhausted) : undefined,
    };
  }

  private buildLocationMeta(steps: AgentToolStep[]): LocationExecutionMeta | undefined {
    const locationTools = new Set(["project_scan", "locate_relevant_files", "context_pack"]);
    const locationSteps = steps.filter((s) => locationTools.has(s.tool));
    const directSearchCalls = steps.filter((s) => s.tool === "search_text").length;
    const directListCalls = steps.filter((s) => s.tool === "list_files").length;
    const directReadCalls = steps.filter((s) => s.tool === "read_file").length;
    if (!locationSteps.length && !directSearchCalls && !directListCalls && !directReadCalls) return undefined;

    const locatedFiles = new Set<string>();
    const candidateFiles = new Set<string>();
    let usedSearchCalls = directSearchCalls;
    let usedListCalls = directListCalls;
    let usedReadForLocationCalls = directReadCalls;
    let stopReason: string | undefined;
    let needsContinue = false;
    let confidence: number | undefined;

    for (const step of locationSteps) {
      const output = step.output as Record<string, unknown> | undefined;
      if (!output) continue;
      const stats = output.locateStats as Record<string, unknown> | undefined;
      usedSearchCalls += readNumber(stats?.usedSearchCalls);
      usedListCalls += readNumber(stats?.usedListCalls);
      usedReadForLocationCalls += readNumber(stats?.usedReadForLocationCalls);
      stopReason = typeof output.stopReason === "string" ? output.stopReason : stopReason;
      needsContinue = needsContinue || output.needsMoreSearch === true || output.needsContinue === true;
      confidence = Math.max(confidence ?? 0, readNumber(output.confidence));

      for (const item of readPathItems(output.primaryFiles)) locatedFiles.add(item);
      for (const item of readPathItems(output.files)) locatedFiles.add(item);
      for (const item of readPathItems(output.candidateFiles)) candidateFiles.add(item);
      for (const item of readPathItems(output.importantFiles)) candidateFiles.add(item);
    }

    return {
      usedLocateSteps: locationSteps.length,
      usedSearchCalls,
      usedListCalls,
      usedReadForLocationCalls,
      locatedFiles: [...locatedFiles].slice(0, 30),
      candidateFiles: [...candidateFiles].filter((p) => !locatedFiles.has(p)).slice(0, 30),
      stopReason,
      needsContinue,
      confidence,
    };
  }

  private buildBudgetUsage(steps: AgentToolStep[], modelTurns: number): RunBudgetUsage {
    const permissionUsage = this.countSuccessfulPermissionUsage(steps);
    return {
      modelTurns,
      toolCalls: steps.length,
      readCalls: permissionUsage.readCalls,
      writeCalls: permissionUsage.writeCalls,
      shellCalls: permissionUsage.shellCalls,
      runtimeMs: Math.max(0, Date.now() - this.runStartedAt),
    };
  }

  private countSuccessfulPermissionUsage(steps: AgentToolStep[]): Pick<
    RunBudgetUsage,
    "readCalls" | "writeCalls" | "shellCalls"
  > {
    const successful = steps.filter((s) => s.ok);
    return {
      readCalls: successful.filter((s) => s.permission === "read").length,
      writeCalls: successful.filter((s) => s.permission === "write" || s.permission === "dangerous").length,
      shellCalls: successful.filter((s) => s.permission === "shell").length,
    };
  }

  private buildSuggestedBudget(exhausted?: RunBudgetKey): RunBudget {
    const suggested = { ...this.policy.suggestedBudget };
    if (exhausted) {
      suggested[exhausted] = Math.max(suggested[exhausted], this.budget[exhausted] * 2);
    }
    return suggested;
  }

  private writeAgentDecisionTrace(event: {
    iteration: number;
    action: "tool" | "final" | "parse_error";
    tool?: string;
    toolCallId?: string;
    thought?: string;
    inputPreview?: string;
    rawPreview?: string;
    answerLength?: number;
  }): void {
    this.options.trace?.write({
      type: "agent_decision",
      runId: this.options.runId,
      sessionId: this.options.sessionId,
      taskId: this.options.taskId,
      mode: this.policy.mode,
      ...event,
    });
  }

  private recordModelTurn(metric: AgentModelTurnMetric): void {
    this.modelTurnMetrics.push(metric);
    this.options.trace?.write({
      type: "agent_model_turn",
      runId: this.options.runId,
      sessionId: this.options.sessionId,
      taskId: this.options.taskId,
      mode: this.policy.mode,
      ...metric,
    });
  }

  private writeRunUsageSummary(steps: AgentToolStep[], executionMeta: AgentExecutionMeta): void {
    const inputTokens = sumOptional(this.modelTurnMetrics.map((m) => m.inputTokens));
    const outputTokens = sumOptional(this.modelTurnMetrics.map((m) => m.outputTokens));
    const costUsd = sumOptional(this.modelTurnMetrics.map((m) => m.costUsd));
    const modelLatencyMs = this.modelTurnMetrics.reduce((sum, m) => sum + m.latencyMs, 0);
    const modelErrors = this.modelTurnMetrics.filter((m) => !m.success);
    const failedTools = steps.filter((s) => !s.ok && !s.blocked);
    this.options.trace?.write({
      type: "run_usage_summary",
      runId: this.options.runId,
      sessionId: this.options.sessionId,
      taskId: this.options.taskId,
      mode: this.policy.mode,
      status: executionMeta.stopReason,
      reachedLimit: executionMeta.stopReason === "budget_exhausted",
      budget: executionMeta.budget,
      usage: executionMeta.usage,
      modelTurns: this.modelTurnMetrics.length,
      modelSuccesses: this.modelTurnMetrics.filter((m) => m.success).length,
      modelErrors: modelErrors.length,
      inputTokens,
      outputTokens,
      totalTokens:
        inputTokens === undefined && outputTokens === undefined
          ? undefined
          : (inputTokens ?? 0) + (outputTokens ?? 0),
      modelLatencyMs,
      costUsd,
      toolCalls: steps.length,
      failedTools: failedTools.length,
      blockedTools: steps.filter((s) => s.blocked).length,
      errors: [
        ...modelErrors.map((m) => m.error).filter((e): e is string => Boolean(e)),
        ...failedTools.map((s) => s.error).filter((e): e is string => Boolean(e)),
      ].slice(0, 10),
    });
  }

  private makeToolCallId(iteration: number, tool: string): string {
    const prefix = this.options.runId ?? this.options.requestId ?? this.options.taskId ?? "agent";
    return `${prefix}:iter-${iteration}:${tool}`;
  }

  private writeAgentStepPlanTrace(steps: AgentToolStep[]): void {
    if (!this.options.trace || !this.options.runId) return;
    const plan: AgentStepPlan = {
      runId: this.options.runId,
      mode: this.policy.mode === "implement" ? "execute" : this.policy.mode,
      ephemeral: true,
      createdAt: new Date().toISOString(),
      steps: steps.map((step, index) => ({
        id: step.iteration > 0 ? `iteration-${step.iteration}` : `workflow-${index + 1}`,
        intent: step.tool,
        tool: step.tool,
        reason: step.thought ?? `模型请求调用 ${step.tool}`,
        status: step.ok ? "done" : step.blocked ? "skipped" : "failed",
      })),
    };
    this.options.trace.write({
      type: "agent_step_plan",
      runId: plan.runId,
      mode: plan.mode,
      ephemeral: true,
      stepCount: plan.steps.length,
      steps: plan.steps,
      createdAt: plan.createdAt,
    });
  }

  private buildPartialFinalAnswer(steps: AgentToolStep[], budgetExhausted: RunBudgetKey): string {
    const okSteps = steps.filter((s) => s.ok);
    const blockedSteps = steps.filter((s) => s.blocked);
    const failedSteps = steps.filter((s) => !s.ok && !s.blocked);
    const modified = okSteps.filter((s) => s.permission === "write" || s.permission === "dangerous");
    const suggested = this.buildSuggestedBudget(budgetExhausted);

    const lines = [
      `已达到当前运行预算（${budgetExhausted}=${this.budget[budgetExhausted]}），我已停止继续调用模型或工具，并基于已有信息做部分收尾。`,
      "",
      okSteps.length
        ? `已完成：${okSteps.map((s) => `${s.tool}#${s.iteration}`).join("、")}。`
        : "已完成：尚未成功执行工具调用。",
    ];

    if (blockedSteps.length) {
      lines.push(`被阻塞：${blockedSteps.map((s) => `${s.tool}#${s.iteration}（${s.error ?? "权限或确认限制"}）`).join("、")}。`);
    }
    if (failedSteps.length) {
      lines.push(`执行失败：${failedSteps.map((s) => `${s.tool}#${s.iteration}（${s.error ?? "未知错误"}）`).join("、")}。`);
    }
    const location = this.buildLocationMeta(steps);
    if (location) {
      lines.push(
        location.locatedFiles.length
          ? `已定位文件：${location.locatedFiles.slice(0, 8).join("、")}。`
          : "已定位文件：尚未确认 primary 文件。",
      );
      if (location.candidateFiles.length) {
        lines.push(`候选文件：${location.candidateFiles.slice(0, 8).join("、")}。`);
      }
      if (location.needsContinue) {
        lines.push("定位状态：仍需要继续定位或扩大定位预算。");
      }
    }

    lines.push(
      "缺失信息：模型尚未输出 final 动作，因此当前结论可能不完整；如需继续，请提高预算或缩小任务范围。",
      `建议继续预算：${renderBudget(suggested)}。`,
      modified.length
        ? `本次已执行写入/高风险类工具 ${modified.length} 次，请以 steps 中的工具结果为准核对影响范围。`
        : "本次未执行写入类工具，未修改文件。",
    );

    return lines.join("\n");
  }
}

function sumOptional(values: Array<number | undefined>): number | undefined {
  let seen = false;
  let sum = 0;
  for (const value of values) {
    if (value === undefined) continue;
    seen = true;
    sum += value;
  }
  return seen ? Number(sum.toFixed(6)) : undefined;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readPathItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string") {
        return (item as { path: string }).path;
      }
      return undefined;
    })
    .filter((item): item is string => Boolean(item));
}

function renderBudget(budget: RunBudget): string {
  return [
    `maxModelTurns=${budget.maxModelTurns}`,
    `maxToolCalls=${budget.maxToolCalls}`,
    `maxReadCalls=${budget.maxReadCalls}`,
    `maxWriteCalls=${budget.maxWriteCalls}`,
    `maxShellCalls=${budget.maxShellCalls}`,
    `maxRuntimeMs=${budget.maxRuntimeMs}`,
  ].join(", ");
}

/** 将安全点消费的通知格式化为可回灌给模型的用户消息。 */
export function renderNotifications(notes: AgentNotification[]): string {
  const lines = notes.map((n) => {
    const merged = readMergeCount(n.payload);
    const mergeHint = merged > 1 ? ` [合并×${merged}]` : "";
    return `- [${n.source}/${n.level}]${mergeHint} ${n.timestamp}: ${n.message}`;
  });
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
