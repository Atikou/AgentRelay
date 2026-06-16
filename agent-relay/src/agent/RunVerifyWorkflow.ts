import type { ContextManager } from "../context/ContextManager.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { AgentIntentType } from "./IntentTypes.js";
import type { ToolPermission } from "../core/permissions.js";
import type { RunBudget } from "./RunPolicyTypes.js";
import type { AgentToolStep } from "./toolStep.js";

export interface RunVerifyWorkflowOptions {
  registry: ToolRegistry;
  workspaceRoot: string;
  allowedPermissions: ToolPermission[];
  budget: RunBudget;
  trace?: TraceLogger;
  contextManager?: ContextManager;
  sessionId?: string;
  taskId?: string;
  requestId?: string;
}

export interface RunVerifyWorkflowResult {
  steps: AgentToolStep[];
  modelContext: string;
  executed: boolean;
  fallbackReason?: string;
}

const SAFE_COMMANDS = [
  "node --version",
  "node -v",
  "npm --version",
  "npm -v",
  "npm run typecheck",
  "npm test",
  "npm run build",
] as const;

export class RunVerifyWorkflow {
  constructor(private readonly options: RunVerifyWorkflowOptions) {}

  async run(goal: string, intent: AgentIntentType): Promise<RunVerifyWorkflowResult | undefined> {
    if (intent !== "run" && intent !== "verify") return undefined;

    const command = extractSafeCommand(goal);
    if (!command) {
      return this.staticFallback("No safe command was recognized for automatic execution.");
    }
    if (!this.options.allowedPermissions.includes("shell")) {
      return this.staticFallback("The current permission policy does not allow shell execution.");
    }
    if (this.options.budget.maxToolCalls <= 0 || this.options.budget.maxShellCalls <= 0) {
      return this.staticFallback("The current run budget does not allow shell execution.");
    }

    const tool = this.options.registry.get("shell_run");
    const step: AgentToolStep = {
      iteration: 0,
      tool: "shell_run",
      input: {
        command: toExecutableCommand(command),
        timeoutMs: 120_000,
        maxOutputBytes: 40_000,
      },
      permission: tool?.permission,
      thought: `run/verify workflow: execute safe command "${command}" and collect output.`,
      ok: false,
    };

    this.options.trace?.write({
      type: "agent_tool",
      tool: "shell_run",
      iteration: 0,
      runId: this.options.requestId,
      sessionId: this.options.sessionId,
      taskId: this.options.taskId,
      workflow: intent,
    });

    const result = await this.options.registry.run("shell_run", step.input, {
      workspaceRoot: this.options.workspaceRoot,
      allowedPermissions: this.options.allowedPermissions,
      taskId: this.options.taskId,
      sessionId: this.options.sessionId,
      requestId: this.options.requestId,
    });

    const finalStep: AgentToolStep = result.ok
      ? { ...step, ok: true, output: result.output, durationMs: result.durationMs }
      : {
          ...step,
          error: `[${result.code}] ${result.error}`,
          blocked: result.code === "permission_denied",
          durationMs: result.durationMs,
        };

    this.saveToolMessage(finalStep);
    return {
      steps: [finalStep],
      modelContext: renderRunVerifyContext([finalStep], intent),
      executed: true,
    };
  }

  private staticFallback(reason: string): RunVerifyWorkflowResult {
    const result = {
      steps: [],
      modelContext: [
        "run/verify workflow static fallback:",
        `reason: ${reason}`,
        "No shell command was executed. Explain why execution was skipped and provide manual verification guidance.",
      ].join("\n"),
      executed: false,
      fallbackReason: reason,
    };
    this.saveToolMessage({ tool: "run_verify_static_fallback", output: { reason } });
    return result;
  }

  private saveToolMessage(input: { tool: string; output?: unknown; error?: string }): void {
    if (!this.options.contextManager || !this.options.sessionId) return;
    this.options.contextManager.saveToolMessage(
      this.options.sessionId,
      `run/verify workflow step "${input.tool}" result (JSON):\n${JSON.stringify(input.output ?? { error: input.error })}`,
    );
  }
}

export function extractSafeCommand(goal: string): string | undefined {
  const normalized = goal.toLowerCase().replace(/\s+/g, " ").trim();
  for (const command of SAFE_COMMANDS) {
    if (normalized.includes(command)) return command;
  }
  return undefined;
}

function toExecutableCommand(command: string): string {
  if (command === "node --version") return `${quoteCommand(process.execPath)} --version`;
  if (command === "node -v") return `${quoteCommand(process.execPath)} -v`;
  return command;
}

function quoteCommand(command: string): string {
  return `"${command.replace(/"/g, '\\"')}"`;
}

function renderRunVerifyContext(steps: AgentToolStep[], intent: AgentIntentType): string {
  const blocks = steps.map((step, index) => {
    const payload = step.ok ? step.output : { error: step.error, blocked: step.blocked };
    return [
      `## ${index + 1}. ${step.tool}`,
      `thought: ${step.thought ?? ""}`,
      `input: ${JSON.stringify(step.input)}`,
      `output: ${JSON.stringify(payload)}`,
    ].join("\n");
  });
  return [
    `${intent}Workflow automatic verification result:`,
    "The workflow executed a recognized safe command and collected output below. Analyze pass/fail status, failure reason, and next steps. Do not call runWorkflow or verifyWorkflow as ToolRegistry tool names.",
    ...blocks,
  ].join("\n\n");
}
