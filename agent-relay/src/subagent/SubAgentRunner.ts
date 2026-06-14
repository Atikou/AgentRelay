import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { AgentLoop, type LoopChatFn } from "../agent/AgentLoop.js";
import type { ToolPermission } from "../agent/permissions.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { NotificationQueue } from "../background/NotificationQueue.js";
import { getSubAgentRole, resolveGrantedPermissions } from "./roles.js";
import { enqueueSubAgentCompletionNotification } from "./notifyCompletion.js";
import { runSingleShotReview } from "./singleShot.js";
import { hasSuccessfulPreload, preloadReferencedFiles } from "./taskContext.js";
import type {
  SubAgentAggregate,
  SubAgentConflict,
  SubAgentRoleId,
  SubAgentRunOptions,
  SubAgentRunResult,
  SubAgentStatus,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;

export interface SubAgentRunnerDeps {
  chat: LoopChatFn;
  registry: ToolRegistry;
  workspaceRoot: string;
  trace?: TraceLogger;
  projectAllowedPermissions?: ToolPermission[];
  notificationQueue?: NotificationQueue;
  /** dispatch_subagent 最大派生深度，默认 1（不支持无限递归）。 */
  maxSubAgentDispatchDepth?: number;
}

/** 运行单个子 Agent：独立上下文、受限权限、超时与 trace。 */
export class SubAgentRunner {
  constructor(private readonly deps: SubAgentRunnerDeps) {}

  async run(options: SubAgentRunOptions): Promise<SubAgentRunResult> {
    const id = randomUUID();
    const role = getSubAgentRole(options.role);
    const granted = resolveGrantedPermissions(
      role,
      options.grantedPermissions,
      this.deps.projectAllowedPermissions,
    );
    const timeoutMs = options.timeoutMs ?? role.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const budget = { ...role.defaultBudget, ...options.budget };
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
        return this.finishRun({
          id,
          role: options.role,
          parentTaskId,
          status: "completed",
          answer,
          steps: [],
          iterations: 1,
          durationMs,
          grantedPermissions: granted,
        });
      } catch (err) {
        const msg = String(err);
        if (msg.includes("超时")) {
          const durationMs = Math.round(performance.now() - start);
          return this.finishRun({
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
          });
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
      `\n本轮预算：最多 ${budget.maxModelTurns} 次模型轮次、${budget.maxToolCalls} 次工具请求、${budget.maxReadCalls} 次只读工具。请优先基于预读内容给出 final，避免无谓工具调用。`,
    ]
      .filter(Boolean)
      .join("\n");

    const dispatchDepth = options.dispatchDepth ?? 0;
    const canAutoWrite =
      granted.includes("write") && role.allowedPermissions.includes("write");

    const loop = new AgentLoop({
      chat: this.deps.chat,
      registry: this.deps.registry,
      workspaceRoot: this.deps.workspaceRoot,
      projectAllowedPermissions: this.deps.projectAllowedPermissions,
      roleAllowedPermissions: role.allowedPermissions,
      allowedPermissions: options.grantedPermissions,
      budget,
      autoConfirm: canAutoWrite,
      sensitive: options.sensitive,
      trace: this.deps.trace,
      subAgentDispatchDepth: dispatchDepth,
      maxSubAgentDispatchDepth: this.deps.maxSubAgentDispatchDepth ?? 1,
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
        error = `达到子 Agent 运行预算（耗尽 ${result.executionMeta.budgetExhausted ?? "unknown"}，已执行 ${result.steps.length} 个工具步）；可提高对应预算或换用更擅长 JSON 协议的模型`;
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

    return this.finishRun({
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
    });
  }

  private finishRun(result: SubAgentRunResult): SubAgentRunResult {
    if (this.deps.notificationQueue) {
      enqueueSubAgentCompletionNotification(this.deps.notificationQueue, {
        subAgentId: result.id,
        role: result.role,
        parentTaskId: result.parentTaskId,
        status: result.status,
        answer: result.answer,
        error: result.error,
      });
    }
    return result;
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
  return aggregateSubAgentResultsStructured(results).mergedAnswer;
}

export function aggregateSubAgentResultsStructured(
  results: SubAgentRunResult[],
): SubAgentAggregate {
  if (results.length === 0) {
    return {
      status: "failed",
      completed: 0,
      failed: 0,
      timedOut: 0,
      commonFindings: [],
      conflicts: [],
      mergedAnswer: "（无子 Agent 结果）",
    };
  }
  const completed = results.filter((r) => r.status === "completed");
  const failed = results.filter((r) => r.status === "failed");
  const timedOut = results.filter((r) => r.status === "timeout");
  const commonFindings = findCommonFindings(completed);
  const conflicts = detectConflicts(completed);
  const status: SubAgentAggregate["status"] =
    conflicts.length > 0
      ? "conflict"
      : completed.length === 0
        ? "failed"
        : failed.length > 0 || timedOut.length > 0
          ? "partial"
          : "completed";
  const sections = [
    `子 Agent 汇总：${status}（完成 ${completed.length}/${results.length}，失败 ${failed.length}，超时 ${timedOut.length}）`,
    commonFindings.length > 0
      ? `共同结论：\n${commonFindings.map((f) => `- ${f}`).join("\n")}`
      : "共同结论：未发现跨角色重复结论。",
    conflicts.length > 0
      ? `冲突：\n${conflicts.map(renderConflict).join("\n")}`
      : "冲突：未发现明显相反结论。",
    results
    .map((r) => {
      const head = `[${r.role}] ${r.status} · ${r.durationMs}ms · 权限 ${r.grantedPermissions.join(",")}`;
      const body = r.error ? `错误：${r.error}` : r.answer;
      return `${head}\n${body}`;
    })
      .join("\n\n---\n\n"),
  ];
  return {
    status,
    completed: completed.length,
    failed: failed.length,
    timedOut: timedOut.length,
    commonFindings,
    conflicts,
    mergedAnswer: sections.join("\n\n"),
  };
}

function findCommonFindings(results: SubAgentRunResult[]): string[] {
  const byNormalized = new Map<string, { text: string; roles: Set<SubAgentRoleId> }>();
  for (const result of results) {
    for (const sentence of splitFindings(result.answer)) {
      const normalized = normalizeFinding(sentence);
      if (normalized.length < 6) continue;
      const existing = byNormalized.get(normalized) ?? { text: sentence, roles: new Set<SubAgentRoleId>() };
      existing.roles.add(result.role);
      byNormalized.set(normalized, existing);
    }
  }
  return [...byNormalized.values()]
    .filter((item) => item.roles.size >= 2)
    .map((item) => item.text)
    .slice(0, 8);
}

function detectConflicts(results: SubAgentRunResult[]): SubAgentConflict[] {
  const conflicts: SubAgentConflict[] = [];
  for (let i = 0; i < results.length; i += 1) {
    for (let j = i + 1; j < results.length; j += 1) {
      const left = results[i]!;
      const right = results[j]!;
      const pair = detectPairConflict(left, right);
      if (pair) conflicts.push(pair);
    }
  }
  return conflicts.slice(0, 10);
}

function detectPairConflict(
  left: SubAgentRunResult,
  right: SubAgentRunResult,
): SubAgentConflict | undefined {
  const leftFindings = splitFindings(left.answer);
  const rightFindings = splitFindings(right.answer);
  for (const l of leftFindings) {
    for (const r of rightFindings) {
      const topic = sharedTopic(l, r);
      if (!topic) continue;
      const lPolarity = findingPolarity(l);
      const rPolarity = findingPolarity(r);
      if (lPolarity === "neutral" || rPolarity === "neutral" || lPolarity === rPolarity) continue;
      return {
        topic,
        roles: [left.role, right.role],
        excerpts: [
          { role: left.role, text: l },
          { role: right.role, text: r },
        ],
        reason: "同一主题出现相反结论",
      };
    }
  }
  return undefined;
}

function splitFindings(answer: string): string[] {
  return answer
    .split(/\r?\n|[。；;]+/g)
    .map((line) => line.replace(/^[-*•\d.、\s]+/, "").trim())
    .filter((line) => line.length >= 4)
    .slice(0, 20);
}

function normalizeFinding(text: string): string {
  return text.toLowerCase().replace(/[`"'“”‘’\s，,。；;：:！!？?()[\]{}]/g, "");
}

function sharedTopic(left: string, right: string): string | undefined {
  const leftTokens = topicTokens(left);
  const rightTokens = topicTokens(right);
  const shared = [...leftTokens].filter((token) => rightTokens.has(token));
  return shared[0];
}

function topicTokens(text: string): Set<string> {
  const ascii = text.match(/[A-Za-z_./-]{3,}/g) ?? [];
  const chinese = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const tokens = [...ascii, ...chinese]
    .map((token) => token.toLowerCase())
    .filter((token) => !POLARITY_WORDS.has(token));
  return new Set(tokens);
}

const POSITIVE_RE = /通过|正常|无问题|没有问题|未发现|可用|成功|pass|passed|ok|green/i;
const NEGATIVE_RE = /失败|错误|异常|风险|缺陷|不通过|不可用|未通过|fail|failed|error|bug|broken|red/i;
const POLARITY_WORDS = new Set([
  "通过",
  "正常",
  "无问题",
  "没有问题",
  "未发现",
  "失败",
  "错误",
  "异常",
  "风险",
  "缺陷",
  "pass",
  "passed",
  "fail",
  "failed",
  "error",
]);

function findingPolarity(text: string): "positive" | "negative" | "neutral" {
  const positive = POSITIVE_RE.test(text);
  const negative = NEGATIVE_RE.test(text);
  if (positive && !negative) return "positive";
  if (negative && !positive) return "negative";
  return "neutral";
}

function renderConflict(conflict: SubAgentConflict): string {
  const roles = conflict.roles.join(" vs ");
  const excerpts = conflict.excerpts.map((e) => `${e.role}: ${e.text}`).join(" / ");
  return `- ${conflict.topic}（${roles}）：${conflict.reason}；${excerpts}`;
}
