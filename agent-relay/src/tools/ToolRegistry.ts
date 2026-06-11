import { performance } from "node:perf_hooks";

import type { TraceLogger } from "../trace/TraceLogger.js";
import { redactPreview } from "../util/redact.js";
import type { ToolPermission } from "../agent/permissions.js";
import type { ToolStorage } from "./storage/ToolStorage.js";
import type { Tool, ToolContext, ToolRunResult, ToolSpec } from "./types.js";

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

    const tool = this.tools.get(name);
    if (!tool) {
      const result: ToolRunResult = {
        ok: false,
        tool: name,
        code: "unknown_tool",
        error: `未知工具：${name}`,
        durationMs: elapsed(),
      };
      this.logStorage(name, rawInput, result, startedAt, ctx);
      return result;
    }

    if (ctx.allowedPermissions && !ctx.allowedPermissions.includes(tool.permission)) {
      const result: ToolRunResult = {
        ok: false,
        tool: name,
        code: "permission_denied",
        error: `当前不允许的权限：${tool.permission}`,
        durationMs: elapsed(),
      };
      this.logStorage(name, rawInput, result, startedAt, ctx);
      return result;
    }

    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const result: ToolRunResult = {
        ok: false,
        tool: name,
        code: "invalid_input",
        error: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
        durationMs: elapsed(),
      };
      this.logStorage(name, rawInput, result, startedAt, ctx);
      return result;
    }

    this.trace?.write({
      type: "tool_audit",
      tool: name,
      status: "start",
      permission: tool.permission,
      inputPreview: redactPreview(parsed.data),
      runId: ctx.requestId,
      sessionId: ctx.sessionId,
      taskId: ctx.taskId,
    });

    const execCtx: ToolContext = { ...ctx, storage: ctx.storage ?? this.storage };

    try {
      const output = await this.withTimeout(tool, () => tool.execute(parsed.data, execCtx), ctx.signal);
      const durationMs = elapsed();
      this.trace?.write({
        type: "tool_audit",
        tool: name,
        status: "ok",
        durationMs,
        outputPreview: redactPreview(output, 600),
        runId: ctx.requestId,
        sessionId: ctx.sessionId,
        taskId: ctx.taskId,
      });
      const result = { ok: true as const, tool: name, output, durationMs };
      this.logStorage(name, parsed.data, result, startedAt, ctx);
      return result;
    } catch (err) {
      const isTimeout = err instanceof Error && err.message === "__tool_timeout__";
      const error = isTimeout ? `工具执行超时（${tool.timeoutMs}ms）` : String(err);
      this.trace?.write({
        type: "tool_audit",
        tool: name,
        status: "error",
        error: redactPreview(error, 300),
        runId: ctx.requestId,
        sessionId: ctx.sessionId,
        taskId: ctx.taskId,
      });
      const result = {
        ok: false as const,
        tool: name,
        code: (isTimeout ? "timeout" : "error") as "timeout" | "error",
        error,
        durationMs: elapsed(),
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
        inputJson: JSON.stringify(input ?? {}),
        outputJson: JSON.stringify(result.ok ? result.output : { error: result.error, code: result.code }),
        ok: result.ok,
        errorCode: result.ok ? undefined : result.code,
        errorMessage: result.ok ? undefined : result.error,
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

function describeSchema(tool: Tool): string | undefined {
  const shape = (tool.inputSchema as { shape?: Record<string, unknown> }).shape;
  if (!shape) return undefined;
  return Object.keys(shape).join(", ");
}
