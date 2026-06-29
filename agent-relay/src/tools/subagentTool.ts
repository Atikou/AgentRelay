import { z } from "zod";

import type { SubAgentCoordinator } from "../subagent/SubAgentCoordinator.js";
import {
  normalizeDispatchSubagentInput,
  resolveSubagentTimeoutMs,
} from "../subagent/dispatchInputNormalize.js";
import { normalizeDelegatedTask, DEFAULT_READONLY_TOOL_POLICY } from "../subagent/delegatedTask.js";
import type { DelegatedTask, SubAgentStructuredResult } from "../subagent/delegatedTask.js";
import type { ModelSelection } from "../subagent/types.js";
import type { Tool } from "./types.js";

export const DISPATCH_SUBAGENT_TOOL_NAME = "dispatch_subagent";

const delegatedTaskSchema = z.object({
  goal: z.string().min(1).max(4_000),
  instructions: z.string().max(4_000).optional(),
  input: z.string().max(8_000).optional(),
  context: z
    .object({
      files: z.array(z.string()).optional(),
      snippets: z.array(z.string()).optional(),
      logs: z.array(z.string()).optional(),
      previousResults: z.array(z.string()).optional(),
      projectFacts: z.array(z.string()).optional(),
    })
    .optional(),
  toolPolicy: z
    .object({
      allowedTools: z.array(z.string()).optional(),
      writeAllowed: z.boolean().optional(),
      shellAllowed: z.boolean().optional(),
      requireApproval: z.boolean().optional(),
    })
    .optional(),
  modelPolicy: z
    .object({
      prefer: z.enum(["local", "remote", "auto"]).optional(),
      allowRemoteEscalation: z.boolean().optional(),
      requiredCapabilities: z
        .array(z.enum(["reasoning", "code", "vision", "summary", "tool_use", "long_context"]))
        .optional(),
      minQuality: z.enum(["fast", "balanced", "strong"]).optional(),
    })
    .optional(),
});

const inputSchema = z.object({
  tasks: z.array(delegatedTaskSchema).min(1).max(3),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
  grantedPermissions: z
    .array(z.enum(["read", "write", "shell", "network", "dangerous"]))
    .optional(),
  arbitrateConflicts: z.boolean().optional(),
  autoMergeWrites: z.boolean().optional(),
  writeFilePickStrategy: z.enum(["latest", "earliest", "arbitration"]).optional(),
});

export type DispatchSubagentInput = z.infer<typeof inputSchema>;

export interface DispatchSubagentOutput {
  mode: "single" | "batch";
  parentTaskId?: string;
  summary: string;
  results: Array<{
    id: string;
    taskId: string;
    goal: string;
    status: string;
    answer: string;
    structured?: SubAgentStructuredResult;
    durationMs: number;
    iterations: number;
    error?: string;
    modelUsed?: ModelSelection;
  }>;
  aggregate?: {
    status: string;
    completed: number;
    failed: number;
    timedOut: number;
    conflicts: Array<{ topic: string; taskIds: string[]; reason: string }>;
    writeConflicts?: Array<{ path: string; taskIds: string[]; reason: string }>;
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

export const dispatchSubagentTool: Tool<typeof inputSchema, DispatchSubagentOutput> = {
  name: DISPATCH_SUBAGENT_TOOL_NAME,
  description:
    "将大任务拆分为子任务委派给子 Agent：子 Agent 在干净、最小上下文中自行执行，只把压缩结构化结果带回。参数 tasks: DelegatedTask[]，每项含 goal/instructions/toolPolicy/modelPolicy。⚠️ 可能有副作用：当某个子任务设置 toolPolicy.writeAllowed/shellAllowed 且 grantedPermissions 含 write/shell 时，子 Agent 会写文件或执行命令，因此本工具按「可能有副作用」对待。",
  normalizeInput: normalizeDispatchSubagentInput,
  inputSchema,
  // 派发动作本身是 read 级（不直接触碰文件系统），但被派发的子 Agent 可在授权下写盘/跑命令，
  // 故 hasSideEffect 取保守的 true，使工具清单/确认提示如实告知「可能有副作用」。
  permission: "read",
  hasSideEffect: true,
  timeoutMs: 300_000,
  async execute(input, context) {
    const depth = context.subAgentDispatchDepth ?? 0;
    const max = context.maxSubAgentDispatchDepth ?? 1;
    if (depth >= max) {
      throw new Error(`已达到子 Agent 派生深度上限（${max}，当前 depth=${depth}）`);
    }

    const coordinator = context.subAgentCoordinator;
    if (!coordinator) {
      throw new Error("子 Agent 调度未配置（subAgentCoordinator 缺失）");
    }

    const tasks = input.tasks.map((t) => normalizeDelegatedTaskFromInput(t));

    const parentTaskId = context.taskId;
    const sensitive = context.sensitive;
    const childDepth = depth + 1;
    const timeoutMs = resolveSubagentTimeoutMs(input.timeoutMs);
    const parentIntent = context.parentAgentIntent;
    const parentWorkflowType = context.parentAgentWorkflowType;
    const runOpts = {
      tasks,
      parentTaskId,
      timeoutMs,
      sensitive,
      parentIntent,
      parentWorkflowType,
      grantedPermissions: input.grantedPermissions,
      dispatchDepth: childDepth,
      arbitrateConflicts: input.arbitrateConflicts,
      autoMergeWrites: input.autoMergeWrites,
      writeFilePickStrategy: input.writeFilePickStrategy,
    };

    if (tasks.length === 1) {
      const result = await coordinator.runDelegated(tasks[0]!, {
        parentTaskId,
        timeoutMs,
        sensitive,
        parentIntent,
        parentWorkflowType,
        grantedPermissions: input.grantedPermissions,
        dispatchDepth: childDepth,
      });
      return {
        mode: "single",
        parentTaskId,
        summary: formatSingleSummary(result),
        results: [toResultItem(result)],
        durationMs: result.durationMs,
      };
    }

    const batch = await coordinator.runBatch(runOpts);
    return {
      mode: "batch",
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
          taskIds: c.taskIds,
          reason: c.reason,
        })),
        writeConflicts: batch.aggregate.writeConflicts.map((w) => ({
          path: w.path,
          taskIds: w.taskIds,
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
          ? { applied: batch.aggregate.arbitration.applied, summary: batch.aggregate.arbitration.summary }
          : undefined,
        mergedAnswer: batch.aggregate.mergedAnswer,
      },
      durationMs: batch.durationMs,
    };
  },
};

export { normalizeDispatchSubagentInput } from "../subagent/dispatchInputNormalize.js";

function normalizeDelegatedTaskFromInput(partial: z.infer<typeof delegatedTaskSchema>): DelegatedTask {
  return normalizeDelegatedTask({
    goal: partial.goal,
    instructions: partial.instructions,
    input: partial.input,
    context: partial.context,
    toolPolicy: partial.toolPolicy
      ? {
          allowedTools: partial.toolPolicy.allowedTools ?? DEFAULT_READONLY_TOOL_POLICY.allowedTools,
          writeAllowed: partial.toolPolicy.writeAllowed ?? false,
          shellAllowed: partial.toolPolicy.shellAllowed ?? false,
          // 副作用子任务默认须经审批：模型不显式声明时，写/命令型子任务一律 requireApproval=true，
          // 避免「模型自行关闭审批」绕过父级授权与确认门。
          requireApproval:
            partial.toolPolicy.requireApproval ??
            Boolean(partial.toolPolicy.writeAllowed || partial.toolPolicy.shellAllowed),
        }
      : undefined,
        modelPolicy: partial.modelPolicy
      ? {
          prefer: partial.modelPolicy.prefer ?? "auto",
          allowRemoteEscalation: partial.modelPolicy.allowRemoteEscalation ?? true,
          requiredCapabilities: partial.modelPolicy.requiredCapabilities,
          minQuality: partial.modelPolicy.minQuality,
        }
      : undefined,
  });
}

function toResultItem(result: {
  id: string;
  taskId: string;
  goal: string;
  status: string;
  answer: string;
  structured?: SubAgentStructuredResult;
  durationMs: number;
  iterations: number;
  error?: string;
  modelUsed?: ModelSelection;
}) {
  return {
    id: result.id,
    taskId: result.taskId,
    goal: result.goal,
    status: result.status,
    answer: result.answer,
    structured: result.structured,
    durationMs: result.durationMs,
    iterations: result.iterations,
    error: result.error,
    modelUsed: result.modelUsed,
  };
}

function formatSingleSummary(result: {
  goal: string;
  status: string;
  answer: string;
  structured?: SubAgentStructuredResult;
  error?: string;
}): string {
  const head = `[${result.goal.slice(0, 40)}] ${result.status}`;
  const body = result.structured?.summary ?? (result.error ? `${result.error}\n${result.answer}` : result.answer);
  return `${head}\n${body}`;
}

export type { SubAgentCoordinator };
