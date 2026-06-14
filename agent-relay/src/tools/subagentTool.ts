import { z } from "zod";

import type { SubAgentCoordinator } from "../subagent/SubAgentCoordinator.js";
import { SUB_AGENT_ROLES } from "../subagent/roles.js";
import type { SubAgentRoleId } from "../subagent/types.js";
import type { Tool } from "./types.js";

export const DISPATCH_SUBAGENT_TOOL_NAME = "dispatch_subagent";

const roleIds = Object.keys(SUB_AGENT_ROLES) as [SubAgentRoleId, ...SubAgentRoleId[]];
const roleSchema = z.enum(roleIds);

const inputSchema = z.object({
  roles: z.array(roleSchema).min(1).max(3),
  task: z.string().min(1).max(8_000),
  context: z.string().max(8_000).optional(),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
  /** 写权限子 Agent（如 patch_worker）须显式授予，且为角色允许集子集。 */
  grantedPermissions: z
    .array(z.enum(["read", "write", "shell", "network", "dangerous"]))
    .optional(),
  /** 多角色 batch 且存在冲突时启用模型仲裁。 */
  arbitrateConflicts: z.boolean().optional(),
  autoMergeWrites: z.boolean().optional(),
  writeFilePickStrategy: z.enum(["latest", "earliest", "arbitration"]).optional(),
});

export type DispatchSubagentInput = z.infer<typeof inputSchema>;

export interface DispatchSubagentOutput {
  mode: "single" | "batch";
  roles: SubAgentRoleId[];
  parentTaskId?: string;
  summary: string;
  results: Array<{
    id: string;
    role: SubAgentRoleId;
    status: string;
    answer: string;
    durationMs: number;
    iterations: number;
    error?: string;
  }>;
  aggregate?: {
    status: string;
    completed: number;
    failed: number;
    timedOut: number;
    conflicts: Array<{ topic: string; roles: SubAgentRoleId[]; reason: string }>;
    writeConflicts?: Array<{ path: string; roles: SubAgentRoleId[]; reason: string }>;
    writeMerges?: Array<{
      path: string;
      status: string;
      changeId?: string;
      reason: string;
      appliedPatches: number;
    }>;
    arbitration?: { applied: boolean; summary: string };
    mergedAnswer: string;
  };
  durationMs: number;
}

/** 主 Agent 派生子 Agent；派生深度受 security.subagent.maxDispatchDepth 约束，不支持无限递归。 */
export const dispatchSubagentTool: Tool<typeof inputSchema, DispatchSubagentOutput> = {
  name: DISPATCH_SUBAGENT_TOOL_NAME,
  description:
    "派生一个或多个子 Agent 并行或单独执行任务，返回结构化汇总。roles 只能是 code_review/test_analyze/patch_worker；task 与 context 必须是字符串。只读分析任务优先 code_review/test_analyze；不要使用 plan/time_scheduling 等自造角色。写权限角色 patch_worker 须 grantedPermissions 含 write。深度受配置上限约束，不可无限递归。",
  normalizeInput: normalizeDispatchSubagentInput,
  inputSchema,
  permission: "read",
  hasSideEffect: false,
  timeoutMs: 300_000,
  async execute(input, context) {
    const depth = context.subAgentDispatchDepth ?? 0;
    const max = context.maxSubAgentDispatchDepth ?? 1;
    if (depth >= max) {
      throw new Error(
        `已达到子 Agent 派生深度上限（${max}，当前 depth=${depth}）；不支持无限递归派生`,
      );
    }

    const coordinator = context.subAgentCoordinator;
    if (!coordinator) {
      throw new Error(
        "子 Agent 调度未配置（subAgentCoordinator 缺失）；请通过服务端 AgentLoop 使用，勿直接调用 /api/tools/run",
      );
    }

    const parentTaskId = context.taskId;
    const sensitive = context.sensitive;
    const roles = dedupeRoles(input.roles);
    const childDepth = depth + 1;
    const runOpts = {
      task: input.task.trim(),
      context: input.context,
      parentTaskId,
      timeoutMs: input.timeoutMs,
      sensitive,
      grantedPermissions: input.grantedPermissions,
      dispatchDepth: childDepth,
      arbitrateConflicts: input.arbitrateConflicts,
      autoMergeWrites: input.autoMergeWrites,
      writeFilePickStrategy: input.writeFilePickStrategy,
    };

    if (roles.length === 1) {
      const role = roles[0]!;
      const result = await coordinator.run({ role, ...runOpts });
      return {
        mode: "single",
        roles,
        parentTaskId,
        summary: formatSingleSummary(result),
        results: [toResultItem(result)],
        durationMs: result.durationMs,
      };
    }

    const batch = await coordinator.runBatch({ roles, ...runOpts });
    return {
      mode: "batch",
      roles,
      parentTaskId: batch.parentTaskId,
      summary: batch.summary,
      results: batch.results.map(toResultItem),
      aggregate: {
        status: batch.aggregate.status,
        completed: batch.aggregate.completed,
        failed: batch.aggregate.failed,
        timedOut: batch.aggregate.timedOut,
        conflicts: batch.aggregate.conflicts.map((c) => ({
          topic: c.topic,
          roles: c.roles,
          reason: c.reason,
        })),
        writeConflicts: batch.aggregate.writeConflicts.map((w) => ({
          path: w.path,
          roles: w.roles,
          reason: w.reason,
        })),
        writeMerges: batch.aggregate.writeMerges?.map((w) => ({
          path: w.path,
          status: w.status,
          changeId: w.changeId,
          reason: w.reason,
          appliedPatches: w.appliedPatches,
        })),
        arbitration: batch.aggregate.arbitration
          ? {
              applied: batch.aggregate.arbitration.applied,
              summary: batch.aggregate.arbitration.summary,
            }
          : undefined,
        mergedAnswer: batch.aggregate.mergedAnswer,
      },
      durationMs: batch.durationMs,
    };
  },
};

export function normalizeDispatchSubagentInput(rawInput: unknown): unknown {
  if (!isRecord(rawInput)) return rawInput;
  const out: Record<string, unknown> = { ...rawInput };
  const taskItems = Array.isArray(out.task) ? out.task.map(formatTaskItem) : undefined;

  if (Array.isArray(out.roles)) {
    let roles = out.roles.map((role) => normalizeRoleValue(role));
    if (taskItems && taskItems.length > 1 && roles.every((role) => role === "code_review")) {
      roles = taskItems.map(inferRoleFromTask);
    }
    const grants = Array.isArray(out.grantedPermissions)
      ? out.grantedPermissions.filter((p): p is string => typeof p === "string")
      : [];
    if (!grants.includes("write") && roles.includes("patch_worker") && roles.some((r) => r !== "patch_worker")) {
      roles = roles.filter((role) => role !== "patch_worker");
    }
    out.roles = roles;
  }

  if (taskItems) {
    out.task = taskItems.join("\n");
  } else if (isRecord(out.task)) {
    out.task = formatTaskItem(out.task);
  }

  if (isRecord(out.context)) {
    out.context = Object.keys(out.context).length === 0 ? "" : JSON.stringify(out.context);
  }

  if (out.writeFilePickStrategy === null) {
    delete out.writeFilePickStrategy;
  }

  return out;
}

function dedupeRoles(roles: SubAgentRoleId[]): SubAgentRoleId[] {
  const seen = new Set<SubAgentRoleId>();
  const out: SubAgentRoleId[] = [];
  for (const role of roles) {
    if (seen.has(role)) continue;
    seen.add(role);
    out.push(role);
  }
  return out;
}

function toResultItem(result: {
  id: string;
  role: SubAgentRoleId;
  status: string;
  answer: string;
  durationMs: number;
  iterations: number;
  error?: string;
}) {
  return {
    id: result.id,
    role: result.role,
    status: result.status,
    answer: result.answer,
    durationMs: result.durationMs,
    iterations: result.iterations,
    error: result.error,
  };
}

function formatSingleSummary(result: {
  role: SubAgentRoleId;
  status: string;
  answer: string;
  error?: string;
}): string {
  const head = `[${result.role}] ${result.status}`;
  const body = result.error ? `${result.error}\n${result.answer}` : result.answer;
  return `${head}\n${body}`;
}

export type { SubAgentCoordinator };

function normalizeRoleValue(value: unknown): SubAgentRoleId {
  if (value === "code_review" || value === "test_analyze" || value === "patch_worker") return value;
  if (typeof value !== "string") return "code_review";
  const lower = value.toLowerCase();
  if (/patch|write|edit|fix|补丁|修改|修复/.test(lower)) return "patch_worker";
  if (/test|risk|verify|time|schedule|坚持|风险|时间|测试|验证/.test(lower)) return "test_analyze";
  return "code_review";
}

function inferRoleFromTask(task: string): SubAgentRoleId {
  const lower = task.toLowerCase();
  if (/patch|write|edit|fix|补丁|修改|修复/.test(lower)) return "patch_worker";
  if (/test|risk|verify|time|schedule|坚持|风险|时间|测试|验证/.test(lower)) return "test_analyze";
  return "code_review";
}

function formatTaskItem(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return String(value);
  const goal = typeof value.goal === "string" ? value.goal : undefined;
  const mode = typeof value.mode === "string" ? value.mode : undefined;
  const task = typeof value.task === "string" ? value.task : undefined;
  const title = task ?? goal ?? JSON.stringify(value);
  return mode ? `- ${title}（${mode}）` : `- ${title}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
