import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

import {
  DEFAULT_SHELL_MAX_OUTPUT_BYTES,
  DEFAULT_SHELL_TIMEOUT_MS,
} from "./constants.js";
import { resolveInsideWorkspace } from "./pathSafe.js";
import { classifyShellCommand, assertShellAllowed } from "../policy/ShellPolicy.js";
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
    const { tier: riskLevel, blocked, verdict } = classifyShellCommand(input.command);
    if (blocked) {
      throw new Error(`高风险命令被拒绝：${verdict.reason}`);
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
      };
    } catch (err) {
      const e = err as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        message?: string;
        killed?: boolean;
      };
      const timedOut = e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || e.killed === true;
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
      };
    }
  },
};
