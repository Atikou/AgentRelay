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
    arbitration?: { applied: boolean; summary: string };
    mergedAnswer: string;
  };
  durationMs: number;
}

/** 主 Agent 派生子 Agent；派生深度受 security.subagent.maxDispatchDepth 约束，不支持无限递归。 */
export const dispatchSubagentTool: Tool<typeof inputSchema, DispatchSubagentOutput> = {
  name: DISPATCH_SUBAGENT_TOOL_NAME,
  description:
    "派生一个或多个子 Agent 并行或单独执行任务，返回结构化汇总。只读角色：code_review、test_analyze；写权限角色 patch_worker 须 grantedPermissions 含 write。深度受配置上限约束，不可无限递归。",
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
