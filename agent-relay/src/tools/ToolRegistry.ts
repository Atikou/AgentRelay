import { performance } from "node:perf_hooks";
import crypto from "node:crypto";

import type { TraceLogger } from "../trace/TraceLogger.js";
import { extractNetworkTarget } from "../policy/NetworkPolicy.js";
import { assessPermissionDeniedRisk, assessToolRisk } from "../policy/ToolRiskAssessment.js";
import { redactPreview, redactString, redactValue } from "../util/redact.js";
import type { ToolPermission } from "../core/permissions.js";
import { CONFIRMATION_REQUIRED } from "../core/permissions.js";
import type { ToolStorage } from "./storage/ToolStorage.js";
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
      const result: ToolRunResult = {
        ok: false,
        tool: name,
        code: "unknown_tool",
        category: "user_error",
        error: `未知工具：${name}`,
        durationMs: elapsed(),
        toolCallId,
      };
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
      const result: ToolRunResult = {
        ok: false,
        tool: name,
        code: "permission_denied",
        category: "permission_error",
        error: `当前不允许的权限：${tool.permission}`,
        durationMs: elapsed(),
        toolCallId,
        risk,
      };
      this.logStorage(name, rawInput, result, startedAt, ctx);
      return result;
    }

    const normalizedInput = tool.normalizeInput ? tool.normalizeInput(rawInput) : rawInput;
    const parsed = tool.inputSchema.safeParse(normalizedInput);
    if (!parsed.success) {
      const result: ToolRunResult = {
        ok: false,
        tool: name,
        code: "invalid_input",
        category: "user_error",
        error: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
        durationMs: elapsed(),
        toolCallId,
      };
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
          const result: ToolRunResult = {
            ok: false,
            tool: name,
            code: "permission_denied",
            category: "permission_error",
            error: decision.reason ?? `域名被策略拒绝：${decision.hostname}`,
            durationMs: elapsed(),
            toolCallId,
            risk,
          };
          this.logStorage(name, rawInput, result, startedAt, ctx);
          return result;
        }
      }
    }

    const execCtx: ToolContext = {
      ...this.defaultContext,
      ...ctx,
      toolCallId,
      storage: ctx.storage ?? this.storage,
      shellPolicy: ctx.shellPolicy ?? this.defaultContext.shellPolicy,
      networkPolicy: ctx.networkPolicy ?? this.defaultContext.networkPolicy,
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
      const output = await this.withTimeout(tool, () => tool.execute(parsed.data, execCtx), ctx.signal);
      const durationMs = elapsed();
      this.trace?.write({
        type: "tool_audit",
        tool: name,
        status: "ok",
        durationMs,
        outputPreview: redactPreview(output, 600),
        toolCallId,
        runId: ctx.requestId,
        sessionId: ctx.sessionId,
        taskId: ctx.taskId,
      });
      const result = { ok: true as const, tool: name, output, durationMs, toolCallId };
      this.logStorage(name, parsed.data, result, startedAt, ctx);
      return result;
    } catch (err) {
      const isTimeout = err instanceof Error && err.message === "__tool_timeout__";
      const code: ToolErrorCode = isTimeout ? "timeout" : "error";
      const error = isTimeout ? `工具执行超时（${tool.timeoutMs}ms）` : String(err);
      const category = classifyToolError(code, error);
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
        status: "error",
        code,
        category,
        error: redactPreview(error, 300),
        toolCallId,
        runId: ctx.requestId,
        sessionId: ctx.sessionId,
        taskId: ctx.taskId,
      });
      const result = {
        ok: false as const,
        tool: name,
        code,
        category,
        error,
        durationMs: elapsed(),
        toolCallId,
        risk,
      };
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
          result.ok ? result.output : { error: result.error, code: result.code, category: result.category },
        ),
        ok: result.ok,
        errorCode: result.ok ? undefined : result.code,
        errorMessage: result.ok ? undefined : redactString(result.error),
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
    signal?: AbortSignal,
  ): Promise<T> {
    if (!tool.timeoutMs) return fn();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error("__tool_timeout__")), tool.timeoutMs);
          if (signal) signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
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
