import { performance } from "node:perf_hooks";

import type { TraceLogger } from "../trace/TraceLogger.js";
import type { ToolPermission } from "../agent/permissions.js";
import type { Tool, ToolContext, ToolRunResult, ToolSpec } from "./types.js";

export interface RegistryRunContext extends ToolContext {
  /** 本次允许的权限集；提供时，工具权限不在其中则拒绝。 */
  allowedPermissions?: ToolPermission[];
}

/**
 * 工具注册表：集中注册工具，并在执行前完成入参校验、权限边界检查、超时控制与 trace。
 * `run` 返回归一化结果（不抛异常），便于服务端与执行器统一分支处理。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(private readonly trace?: TraceLogger) {}

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
    const elapsed = () => Math.round(performance.now() - started);

    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, tool: name, code: "unknown_tool", error: `未知工具：${name}`, durationMs: elapsed() };
    }

    if (ctx.allowedPermissions && !ctx.allowedPermissions.includes(tool.permission)) {
      return {
        ok: false,
        tool: name,
        code: "permission_denied",
        error: `当前不允许的权限：${tool.permission}`,
        durationMs: elapsed(),
      };
    }

    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        ok: false,
        tool: name,
        code: "invalid_input",
        error: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
        durationMs: elapsed(),
      };
    }

    this.trace?.write({ type: "tool_call", tool: name, status: "start" });
    try {
      const output = await this.withTimeout(tool, () => tool.execute(parsed.data, ctx), ctx.signal);
      const durationMs = elapsed();
      this.trace?.write({ type: "tool_call", tool: name, status: "ok", durationMs });
      return { ok: true, tool: name, output, durationMs };
    } catch (err) {
      const isTimeout = err instanceof Error && err.message === "__tool_timeout__";
      const error = isTimeout ? `工具执行超时（${tool.timeoutMs}ms）` : String(err);
      this.trace?.write({ type: "tool_call", tool: name, status: "error", error });
      return { ok: false, tool: name, code: isTimeout ? "timeout" : "error", error, durationMs: elapsed() };
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
