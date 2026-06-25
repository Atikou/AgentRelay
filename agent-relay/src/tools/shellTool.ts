import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

import {
  DEFAULT_SHELL_MAX_OUTPUT_BYTES,
  DEFAULT_SHELL_TIMEOUT_MS,
} from "./constants.js";
import { resolveInsideWorkspace } from "./pathSafe.js";
import { classifyShellCommand } from "../policy/ShellPolicy.js";
import type { Tool } from "./types.js";

const execAsync = promisify(exec);

function clipOutput(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text ?? "", "utf-8");
  if (buf.byteLength <= maxBytes) return { text: text ?? "", truncated: false };
  return { text: buf.subarray(0, maxBytes).toString("utf-8"), truncated: true };
}

/** shell_run：在工作区内执行 Shell 命令（超时/输出限制/风险拦截）。 */
export const shellRunTool: Tool<
  z.ZodObject<{
    command: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
    timeoutMs: z.ZodDefault<z.ZodNumber>;
    maxOutputBytes: z.ZodDefault<z.ZodNumber>;
  }>,
  {
    command: string;
    cwd: string;
    exitCode?: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    truncated: boolean;
    riskLevel: "low" | "medium" | "high";
    spawnFailed?: boolean;
  }
> = {
  name: "shell_run",
  description: "在工作区内执行 Shell 命令；高风险命令拒绝，输出与超时受限。",
  permission: "shell",
  hasSideEffect: true,
  timeoutMs: DEFAULT_SHELL_TIMEOUT_MS + 5_000,
  inputSchema: z.object({
    command: z.string().min(1),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().max(300_000).default(DEFAULT_SHELL_TIMEOUT_MS),
    maxOutputBytes: z.number().int().positive().max(2_000_000).default(DEFAULT_SHELL_MAX_OUTPUT_BYTES),
  }),
  async execute(input, ctx) {
    const decision = ctx.shellPolicy?.evaluate(input.command);
    if (decision?.blocked) {
      throw new Error(`命令被策略拒绝：${decision.reason ?? decision.verdict.reason}`);
    }
    const baseRisk = classifyShellCommand(input.command);
    const riskLevel = decision?.tier ?? baseRisk.tier;
    if (!decision && baseRisk.blocked) {
      throw new Error(`高风险命令被拒绝：${baseRisk.verdict.reason}`);
    }

    const cwdRel = input.cwd ?? ".";
    const cwd = resolveInsideWorkspace(ctx.workspaceRoot, cwdRel);

    try {
      const { stdout, stderr } = await execAsync(input.command, {
        cwd,
        timeout: input.timeoutMs,
        maxBuffer: input.maxOutputBytes * 2,
        signal: ctx.signal,
        windowsHide: true,
      });
      const out = clipOutput(stdout, input.maxOutputBytes);
      const errOut = clipOutput(stderr, input.maxOutputBytes);
      return {
        command: input.command,
        cwd: cwdRel,
        exitCode: 0,
        stdout: out.text,
        stderr: errOut.text,
        timedOut: false,
        truncated: out.truncated || errOut.truncated,
        riskLevel,
        spawnFailed: false,
      };
    } catch (err) {
      const e = err as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        message?: string;
        killed?: boolean;
      };
      // 执行器无法启动（非命令退出码）→ 抛给 Registry 记为 execution_error
      const spawnFailedString =
        typeof e.code === "string" && e.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      if (spawnFailedString || (e.code == null && !e.stdout && !e.stderr?.trim())) {
        throw err;
      }
      const timedOut =
        e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
        e.killed === true ||
        /timed out|ETIMEDOUT/i.test(e.message ?? "");
      const out = clipOutput(e.stdout ?? "", input.maxOutputBytes);
      const errOut = clipOutput(e.stderr ?? e.message ?? String(err), input.maxOutputBytes);
      return {
        command: input.command,
        cwd: cwdRel,
        exitCode: typeof e.code === "number" ? e.code : 1,
        stdout: out.text,
        stderr: errOut.text,
        timedOut,
        truncated: out.truncated || errOut.truncated,
        riskLevel,
        spawnFailed: false,
      };
    }
  },
};
