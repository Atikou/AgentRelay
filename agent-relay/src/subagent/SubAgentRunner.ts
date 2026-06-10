import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { AgentLoop, type LoopChatFn } from "../agent/AgentLoop.js";
import type { ToolPermission } from "../agent/permissions.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import { getSubAgentRole, resolveGrantedPermissions } from "./roles.js";
import { runSingleShotReview } from "./singleShot.js";
import { hasSuccessfulPreload, preloadReferencedFiles } from "./taskContext.js";
import type { SubAgentRunOptions, SubAgentRunResult, SubAgentStatus } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ITERATIONS = 10;

export interface SubAgentRunnerDeps {
  chat: LoopChatFn;
  registry: ToolRegistry;
  workspaceRoot: string;
  trace?: TraceLogger;
}

/** 运行单个子 Agent：独立上下文、受限权限、超时与 trace。 */
export class SubAgentRunner {
  constructor(private readonly deps: SubAgentRunnerDeps) {}

  async run(options: SubAgentRunOptions): Promise<SubAgentRunResult> {
    const id = randomUUID();
    const role = getSubAgentRole(options.role);
    const granted = resolveGrantedPermissions(role, options.grantedPermissions);
    const timeoutMs = options.timeoutMs ?? role.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxIterations =
      options.maxIterations ?? role.defaultMaxIterations ?? DEFAULT_MAX_ITERATIONS;
    const parentTaskId = options.parentTaskId;
    const start = performance.now();

    this.deps.trace?.write({
      type: "subagent_start",
      subAgentId: id,
      role: options.role,
      parentTaskId,
      grantedPermissions: granted,
    });

    const preloaded = await preloadReferencedFiles(
      options.task.trim(),
      this.deps.registry,
      this.deps.workspaceRoot,
    );

    if (role.singleShotWhenPreloaded && hasSuccessfulPreload(preloaded)) {
      try {
        const answer = await raceTimeout(
          runSingleShotReview(role, options.task.trim(), preloaded, this.deps.chat, {
            context: options.context,
            sensitive: options.sensitive,
          }),
          timeoutMs,
        );
        const durationMs = Math.round(performance.now() - start);
        this.deps.trace?.write({
          type: "subagent_end",
          subAgentId: id,
          role: options.role,
          parentTaskId,
          status: "completed",
          mode: "single_shot",
          durationMs,
          iterations: 1,
        });
        return {
          id,
          role: options.role,
          parentTaskId,
          status: "completed",
          answer,
          steps: [],
          iterations: 1,
          durationMs,
          grantedPermissions: granted,
        };
      } catch (err) {
        const msg = String(err);
        if (msg.includes("超时")) {
          const durationMs = Math.round(performance.now() - start);
          return {
            id,
            role: options.role,
            parentTaskId,
            status: "timeout",
            answer: "（子 Agent 执行超时）",
            steps: [],
            iterations: 0,
            durationMs,
            grantedPermissions: granted,
            error: msg,
          };
        }
        // 单次模式失败则回退 ReAct 循环
      }
    }

    const userContent = [
      options.task.trim(),
      preloaded ? preloaded : "",
      options.context ? `父 Agent 附加上下文：\n${options.context}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const systemExtra = [
      role.systemPrompt,
      parentTaskId ? `父任务 ID：${parentTaskId}` : "",
      `\n本轮最多 ${maxIterations} 次模型迭代；请优先基于预读内容给出 final，避免无谓工具调用。`,
    ]
      .filter(Boolean)
      .join("\n");

    const loop = new AgentLoop({
      chat: this.deps.chat,
      registry: this.deps.registry,
      workspaceRoot: this.deps.workspaceRoot,
      allowedPermissions: granted,
      maxIterations,
      autoConfirm: false,
      sensitive: options.sensitive,
      trace: this.deps.trace,
    });

    let status: SubAgentStatus = "completed";
    let answer = "";
    let steps: SubAgentRunResult["steps"] = [];
    let iterations = 0;
    let error: string | undefined;

    try {
      const result = await raceTimeout(
        loop.run(userContent, systemExtra),
        timeoutMs,
      );
      answer = result.answer;
      steps = result.steps;
      iterations = result.iterations;
      if (result.reachedLimit) {
        status = "failed";
        error = `达到子 Agent 迭代上限（${maxIterations} 次，已执行 ${result.steps.length} 个工具步）；可增大 maxIterations 或换用更擅长 JSON 协议的模型`;
      }
    } catch (err) {
      const msg = String(err);
      status = msg.includes("超时") ? "timeout" : "failed";
      error = msg;
      answer = status === "timeout" ? "（子 Agent 执行超时）" : "（子 Agent 执行失败）";
    }

    const durationMs = Math.round(performance.now() - start);

    this.deps.trace?.write({
      type: "subagent_end",
      subAgentId: id,
      role: options.role,
      parentTaskId,
      status,
      durationMs,
      iterations,
    });

    return {
      id,
      role: options.role,
      parentTaskId,
      status,
      answer,
      steps,
      iterations,
      durationMs,
      grantedPermissions: granted,
      error,
    };
  }
}

async function raceTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`子 Agent 执行超时（${timeoutMs}ms）`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 汇总多个子 Agent 结果为父 Agent 可消费的文本。 */
export function aggregateSubAgentResults(
  results: SubAgentRunResult[],
): string {
  if (results.length === 0) return "（无子 Agent 结果）";
  return results
    .map((r) => {
      const head = `[${r.role}] ${r.status} · ${r.durationMs}ms · 权限 ${r.grantedPermissions.join(",")}`;
      const body = r.error ? `错误：${r.error}` : r.answer;
      return `${head}\n${body}`;
    })
    .join("\n\n---\n\n");
}
