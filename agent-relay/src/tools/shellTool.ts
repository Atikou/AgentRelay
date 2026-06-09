import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

import { resolveInsideWorkspace } from "./pathSafe.js";
import { checkCommandRisk } from "./risk.js";
import type { Tool } from "./types.js";

const execAsync = promisify(exec);

/** shell_run：在工作区内执行 Shell 命令。高危命令直接拦截，副作用命令由上层确认。 */
export const shellRunTool: Tool<
  z.ZodObject<{
    command: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
  }>,
  { exitCode: number; stdout: string; stderr: string; risk: string }
> = {
  name: "shell_run",
  description: "在工作区内执行 Shell 命令（高危命令会被拦截，副作用命令需确认）。",
  permission: "shell",
  hasSideEffect: true,
  timeoutMs: 60_000,
  inputSchema: z.object({
    command: z.string().min(1),
    cwd: z.string().optional(),
  }),
  async execute(input, ctx) {
    const risk = checkCommandRisk(input.command);
    if (risk.level === "dangerous") {
      throw new Error(`危险命令被拦截：${risk.reason}`);
    }

    const cwd = input.cwd ? resolveInsideWorkspace(ctx.workspaceRoot, input.cwd) : ctx.workspaceRoot;

    try {
      const { stdout, stderr } = await execAsync(input.command, {
        cwd,
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
        signal: ctx.signal,
        windowsHide: true,
      });
      return { exitCode: 0, stdout, stderr, risk: risk.level };
    } catch (err) {
      // exec 失败（非零退出/超时）时把退出码与输出归一化返回，而非抛出。
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      return {
        exitCode: typeof e.code === "number" ? e.code : 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message ?? String(err),
        risk: risk.level,
      };
    }
  },
};
