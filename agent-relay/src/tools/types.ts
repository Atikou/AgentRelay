import type { z } from "zod";

import type { ToolPermission } from "../agent/permissions.js";
import type { ShellPolicy } from "../policy/ShellPolicy.js";
import type { NetworkPolicy } from "../policy/NetworkPolicy.js";
import type { StructuredToolRisk } from "../policy/ToolRiskAssessment.js";

export type { ToolPermission };

/** 工具执行时的运行上下文。 */
export interface ToolContext {
  /** 工作区根目录，文件类工具的边界。 */
  workspaceRoot: string;
  /** 关联的任务 id（用于 trace），可选。 */
  taskId?: string;
  /** M6 会话 id，可选。 */
  sessionId?: string;
  /** 请求 id，可选。 */
  requestId?: string;
  /** 单次工具调用 id，用于串联 agent_tool / task_step / tool_audit。 */
  toolCallId?: string;
  /** 工具层持久化（备份/变更/日志），可选。 */
  storage?: import("./storage/ToolStorage.js").ToolStorage;
  /** Shell 执行策略（allowlist / denylist / 风险拦截），可选。 */
  shellPolicy?: ShellPolicy;
  /** 网络域名策略（allowlist / denylist），供未来 network 权限工具复用。 */
  networkPolicy?: NetworkPolicy;
  /** 取消信号。 */
  signal?: AbortSignal;
  /** 持久化项目文件索引（project_files / project_symbols）。 */
  projectIndex?: import("../context/ProjectIndex.js").ProjectIndex;
}

/**
 * 工具定义协议。
 *
 * - `inputSchema` 用 zod 描述入参，注册表执行前会校验。
 * - `permission` 声明所需权限，由注册表对照本次允许集做边界检查。
 * - `hasSideEffect` 表示是否产生副作用（写文件、跑命令等），供上层决定是否需要确认。
 */
export interface Tool<TInput extends z.ZodTypeAny = z.ZodTypeAny, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: TInput;
  permission: ToolPermission;
  hasSideEffect: boolean;
  timeoutMs?: number;
  execute(input: z.infer<TInput>, context: ToolContext): Promise<TOutput>;
}

/** 工具的对外描述（给前端/模型看的精简元信息）。 */
export interface ToolSpec {
  name: string;
  description: string;
  permission: ToolPermission;
  hasSideEffect: boolean;
  /** zod 形状的简单字段说明（尽力而为）。 */
  inputHint?: string;
}

export type ToolErrorCode =
  | "unknown_tool"
  | "invalid_input"
  | "permission_denied"
  | "timeout"
  | "error";

export type ToolErrorCategory =
  | "user_error"
  | "environment_error"
  | "permission_error"
  | "temporary_error"
  | "unknown_error";

/** 注册表执行工具后的归一化结果（不抛异常，便于服务端/执行器分支处理）。 */
export type ToolRunResult =
  | { ok: true; tool: string; output: unknown; durationMs: number; toolCallId?: string }
  | {
      ok: false;
      tool: string;
      code: ToolErrorCode;
      category: ToolErrorCategory;
      error: string;
      durationMs: number;
      toolCallId?: string;
      /** 结构化风险字段（策略拒绝 / 高风险预览）。 */
      risk?: StructuredToolRisk;
    };
