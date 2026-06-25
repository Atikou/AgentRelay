import { performance } from "node:perf_hooks";
import crypto from "node:crypto";

import type { TraceLogger } from "../trace/TraceLogger.js";
import { extractNetworkTarget } from "../policy/NetworkPolicy.js";
import { assessPermissionDeniedRisk, assessToolRisk } from "../policy/ToolRiskAssessment.js";
import { redactPreview, redactString, redactValue } from "../util/redact.js";
import type { ToolPermission } from "../core/permissions.js";
import { CONFIRMATION_REQUIRED } from "../core/permissions.js";
import type { ToolStorage } from "./storage/ToolStorage.js";
import { sanitizeWorkspacePathsInError } from "./pathSafe.js";
import {
  executionError,
  resolveToolOutcome,
  type ToolOutcome,
} from "./toolOutcome.js";
import type { Tool, ToolContext, ToolErrorCategory, ToolErrorCode, ToolRunResult, ToolSpec } from "./types.js";

export interface RegistryRunContext extends ToolContext {
  /** 本次允许的权限集；提供时，工具权限不在其中则拒绝。 */
  allowedPermissions?: ToolPermission[];
}

/**
 * 工具注册表：集中注册工具，并在执行前完成入参校验、权限边界检查、超时控制、trace 与 tool_logs。
 * `run` 返回归一化结果（不抛异常），便于服务端与执行器统一分支处理。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private defaultContext: Partial<ToolContext> = {};

  constructor(
    private readonly trace?: TraceLogger,
    private readonly storage?: ToolStorage,
  ) {}

  register(tool: Tool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具重复注册：${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getStorage(): ToolStorage | undefined {
    return this.storage;
  }

  setDefaultContext(ctx: Partial<ToolContext>): this {
    this.defaultContext = { ...this.defaultContext, ...ctx };
    return this;
  }

  list(): ToolSpec[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      permission: t.permission,
      hasSideEffect: t.hasSideEffect,
      inputHint: describeSchema(t),
    }));
  }

  async run(name: string, rawInput: unknown, ctx: RegistryRunContext): Promise<ToolRunResult> {
    const started = performance.now();
    const startedAt = new Date().toISOString();
    const elapsed = () => Math.round(performance.now() - started);
    const toolCallId = ctx.toolCallId ?? crypto.randomUUID();

    const tool = this.tools.get(name);
    if (!tool) {
      const result = registryExecutionError({
        tool: name,
        durationMs: elapsed(),
        toolCallId,
        code: "unknown_tool",
        category: "user_error",
        kind: "unknown_tool",
        message: `未知工具：${name}`,
      });
      this.logStorage(name, rawInput, result, startedAt, ctx);
      return result;
    }

    if (ctx.allowedPermissions && !ctx.allowedPermissions.includes(tool.permission)) {
      const risk = assessPermissionDeniedRisk(tool.permission, `当前不允许的权限：${tool.permission}`, {
        toolName: name,
        input: rawInput,
        shellPolicy: ctx.shellPolicy ?? this.defaultContext.shellPolicy,
        networkPolicy: ctx.networkPolicy ?? this.defaultContext.networkPolicy,
      });
      const result = registryExecutionError({
        tool: name,
        durationMs: elapsed(),
        toolCallId,
        code: "permission_denied",
        category: "permission_error",
        kind: "permission_denied",
        message: `当前不允许的权限：${tool.permission}`,
        risk,
        requiresUserAction: true,
        recoverable: true,
      });
      this.logStorage(name, rawInput, result, startedAt, ctx);
      return result;
    }

    const normalizedInput = tool.normalizeInput ? tool.normalizeInput(rawInput) : rawInput;
    const parsed = tool.inputSchema.safeParse(normalizedInput);
    if (!parsed.success) {
      const result = registryExecutionError({
        tool: name,
        durationMs: elapsed(),
        toolCallId,
        code: "invalid_input",
        category: "user_error",
        kind: "invalid_input",
        message: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
      });
      this.logStorage(name, normalizedInput, result, startedAt, ctx);
      return result;
    }

    if (tool.permission === "network") {
      const networkPolicy = ctx.networkPolicy ?? this.defaultContext.networkPolicy;
      const target = extractNetworkTarget(parsed.data);
      if (networkPolicy && target) {
        const decision = networkPolicy.evaluateTarget(target);
        if (decision.blocked) {
          const risk = assessPermissionDeniedRisk(
            "network",
            decision.reason ?? `域名被策略拒绝：${decision.hostname}`,
            { toolName: name, input: parsed.data, networkPolicy },
          );
          const result = registryExecutionError({
            tool: name,
            durationMs: elapsed(),
            toolCallId,
            code: "permission_denied",
            category: "permission_error",
            kind: "permission_denied",
            message: decision.reason ?? `域名被策略拒绝：${decision.hostname}`,
            risk,
          });
          this.logStorage(name, rawInput, result, startedAt, ctx);
          return result;
        }
      }
    }

    // 把外部取消信号与「工具超时」合流到同一个 controller，超时即 abort，
    // 让真正尊重 signal 的工具能及时中断，避免超时后仍在后台跑、占用资源/产生副作用。
    const abortController = new AbortController();
    if (ctx.signal) {
      if (ctx.signal.aborted) abortController.abort();
      else ctx.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }

    const execCtx: ToolContext = {
      ...this.defaultContext,
      ...ctx,
      toolCallId,
      storage: ctx.storage ?? this.storage,
      shellPolicy: ctx.shellPolicy ?? this.defaultContext.shellPolicy,
      networkPolicy: ctx.networkPolicy ?? this.defaultContext.networkPolicy,
      signal: abortController.signal,
    };

    this.trace?.write({
      type: "tool_audit",
      tool: name,
      status: "start",
      permission: tool.permission,
      inputPreview: redactPreview(parsed.data),
      toolCallId,
      runId: ctx.requestId,
      sessionId: ctx.sessionId,
      taskId: ctx.taskId,
      riskTier: CONFIRMATION_REQUIRED.includes(tool.permission)
        ? assessToolRisk({
            toolName: name,
            permission: tool.permission,
            input: parsed.data,
            shellPolicy: execCtx.shellPolicy,
            networkPolicy: execCtx.networkPolicy,
          }).tier
        : undefined,
    });

    try {
      const output = await this.withTimeout(tool, () => tool.execute(parsed.data, execCtx), abortController);
      const durationMs = elapsed();
      const outcome = resolveToolOutcome(name, output);
      const auditStatus =
        outcome.class === "observation_success"
          ? "ok"
          : outcome.class === "observation_failure"
            ? "observation_failure"
            : "execution_error";
      this.trace?.write({
        type: "tool_audit",
        tool: name,
        status: auditStatus,
        outcomeClass: outcome.class,
        outcomeKind: outcome.kind,
        durationMs,
        outputPreview: redactPreview(output, 600),
        toolCallId,
        runId: ctx.requestId,
        sessionId: ctx.sessionId,
        taskId: ctx.taskId,
      });
      const result = registryFromOutcome({
        tool: name,
        durationMs,
        toolCallId,
        executed: true,
        outcome,
        output,
      });
      this.logStorage(name, parsed.data, result, startedAt, ctx);
      return result;
    } catch (err) {
      const isTimeout = err instanceof Error && err.message === "__tool_timeout__";
      const code: ToolErrorCode = isTimeout ? "timeout" : "error";
      const rawError = isTimeout ? `工具执行超时（${tool.timeoutMs}ms）` : String(err);
      const error = sanitizeWorkspacePathsInError(ctx.workspaceRoot, rawError);
      const category = classifyToolError(code, error);
      const kind = isTimeout ? "timeout" : /策略拒绝|高风险命令被拒绝/.test(error) ? "policy_blocked" : "tool_crash";
      const policyBlocked = kind === "policy_blocked";
      const risk =
        category === "permission_error" || /策略拒绝|高风险命令被拒绝/.test(error)
          ? assessToolRisk({
              toolName: name,
              permission: tool.permission,
              input: parsed.data,
              shellPolicy: execCtx.shellPolicy,
              networkPolicy: execCtx.networkPolicy,
            })
          : undefined;
      if (risk?.policyBlocked === false && /策略拒绝|高风险命令被拒绝/.test(error)) {
        risk.policyBlocked = true;
        risk.tier = "critical";
      }
      this.trace?.write({
        type: "tool_audit",
        tool: name,
        status: "execution_error",
        outcomeClass: "execution_error",
        outcomeKind: kind,
        code,
        category,
        error: redactPreview(error, 300),
        toolCallId,
        runId: ctx.requestId,
        sessionId: ctx.sessionId,
        taskId: ctx.taskId,
      });
      const result = registryExecutionError({
        tool: name,
        durationMs: elapsed(),
        toolCallId,
        code,
        category,
        kind,
        message: error,
        risk,
        executed: true,
        requiresUserAction: policyBlocked,
        recoverable: policyBlocked,
      });
      this.logStorage(name, parsed.data, result, startedAt, ctx);
      return result;
    }
  }

  /** 关闭 SQLite 连接（测试/进程退出时调用）。 */
  close(): void {
    this.storage?.close();
  }

  private logStorage(
    name: string,
    input: unknown,
    result: ToolRunResult,
    startedAt: string,
    ctx: RegistryRunContext,
  ): void {
    if (!this.storage) return;
    try {
      this.storage.insertToolLog({
        toolName: name,
        sessionId: ctx.sessionId,
        requestId: ctx.requestId,
        inputJson: stringifyStorageJson(input ?? {}),
        outputJson: stringifyStorageJson(
          result.output ?? {
            error: result.error ?? result.message,
            code: result.code,
            category: result.category,
            outcomeClass: result.outcomeClass,
            outcomeKind: result.outcomeKind,
          },
        ),
        ok: result.outcomeClass === "observation_success",
        errorCode: result.code,
        errorMessage: result.outcomeClass === "execution_error" ? redactString(result.error ?? result.message) : undefined,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: result.durationMs,
      });
    } catch {
      /* 日志写入失败不阻断工具执行 */
    }
  }

  private async withTimeout<T>(
    tool: Tool,
    fn: () => Promise<T>,
    controller: AbortController,
  ): Promise<T> {
    if (!tool.timeoutMs) return fn();
    const signal = controller.signal;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            // 先以超时 settle race（保证错误分类为 timeout），再 abort 通知工具停止后续工作。
            reject(new Error("__tool_timeout__"));
            controller.abort();
          }, tool.timeoutMs);
          if (signal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function stringifyStorageJson(value: unknown): string {
  try {
    return JSON.stringify(redactValue(value));
  } catch {
    return JSON.stringify(redactString(String(value)));
  }
}

export function classifyToolError(code: ToolErrorCode, error: string): ToolErrorCategory {
  if (code === "invalid_input" || code === "unknown_tool") return "user_error";
  if (code === "permission_denied") return "permission_error";
  if (code === "timeout") return "temporary_error";

  const text = error.toLowerCase();
  if (
    /enoent|enotdir|eisdir|not found|no such file|找不到|不存在|未找到|command not found|is not recognized/.test(text)
  ) {
    return "environment_error";
  }
  if (/eacces|eperm|permission denied|access denied|权限|策略拒绝|高风险命令|dangerous command/.test(text)) {
    return "permission_error";
  }
  if (/etimedout|timeout|timed out|econnreset|econnrefused|eai_again|temporar|超时|暂时/.test(text)) {
    return "temporary_error";
  }
  return "unknown_error";
}

function describeSchema(tool: Tool): string | undefined {
  const shape = (tool.inputSchema as { shape?: Record<string, unknown> }).shape;
  if (!shape) return undefined;
  return Object.keys(shape).join(", ");
}

function registryFromOutcome(input: {
  tool: string;
  durationMs: number;
  toolCallId: string;
  executed: boolean;
  outcome: ToolOutcome;
  output?: unknown;
  code?: ToolErrorCode;
  category?: ToolErrorCategory;
  risk?: ToolRunResult["risk"];
}): ToolRunResult {
  return {
    tool: input.tool,
    durationMs: input.durationMs,
    toolCallId: input.toolCallId,
    executed: input.executed,
    outcomeClass: input.outcome.class,
    outcomeKind: input.outcome.kind,
    message: input.outcome.message,
    recoverable: input.outcome.recoverable,
    requiresUserAction: input.outcome.requiresUserAction,
    suggestedNextActions: input.outcome.suggestedNextActions,
    outcomePath: input.outcome.path,
    outcomeCommand: input.outcome.command,
    outcomeExitCode: input.outcome.exitCode,
    output: input.output,
    ok: input.outcome.class === "observation_success",
    code: input.code,
    category: input.category,
    risk: input.risk,
    error: input.outcome.class === "execution_error" ? input.outcome.message : undefined,
  };
}

function registryExecutionError(input: {
  tool: string;
  durationMs: number;
  toolCallId: string;
  code: ToolErrorCode;
  category: ToolErrorCategory;
  kind: ToolOutcome["kind"];
  message: string;
  risk?: ToolRunResult["risk"];
  executed?: boolean;
  requiresUserAction?: boolean;
  recoverable?: boolean;
}): ToolRunResult {
  const outcome = executionError(input.kind as "invalid_input", input.message, {
    recoverable: input.recoverable ?? false,
    requiresUserAction: input.requiresUserAction,
  });
  return registryFromOutcome({
    tool: input.tool,
    durationMs: input.durationMs,
    toolCallId: input.toolCallId,
    executed: input.executed ?? false,
    outcome: { ...outcome, kind: input.kind as ToolOutcome["kind"] },
    code: input.code,
    category: input.category,
    risk: input.risk,
  });
}
