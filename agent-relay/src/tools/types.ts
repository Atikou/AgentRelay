import type { z } from "zod";

import type { ToolPermission } from "../core/permissions.js";
import type { ShellPolicy } from "../policy/ShellPolicy.js";
import type { NetworkPolicy } from "../policy/NetworkPolicy.js";
import type { StructuredToolRisk } from "../policy/ToolRiskAssessment.js";
import type { SubAgentCoordinator } from "../subagent/SubAgentCoordinator.js";

import type { ToolOutcomeClass, SuggestedToolAction } from "./toolOutcome.js";

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
  /** 持久化项目文件索引（project_files / project_symbols / project_imports）。 */
  projectIndex?: import("../context/ProjectIndex.js").ProjectIndex;
  /** LanceDB 项目文件语义索引（locate 语义召回）。 */
  projectSemanticIndexer?: import("../context/ProjectSemanticIndexer.js").ProjectSemanticIndexer;
  /** 历史任务/项目记忆相关文件召回。 */
  historyFileRecaller?: import("../context/HistoryFileRecaller.js").HistoryFileRecaller;
  /** 子 Agent 调度器（主 Agent dispatch_subagent 工具使用）。 */
  subAgentCoordinator?: SubAgentCoordinator;
  /** 子 Agent 派生深度；主 Agent 为 0，子 Agent 内递增。 */
  subAgentDispatchDepth?: number;
  /** dispatch_subagent 最大派生深度（来自 security.subagent.maxDispatchDepth）。 */
  maxSubAgentDispatchDepth?: number;
  /** 隐私模式：子 Agent 模型调用继承该标记。 */
  sensitive?: boolean;
  /** 主 Agent 当前 intent（dispatch_subagent 路由提示）。 */
  parentAgentIntent?: string;
  /** 主 Agent 当前 workflowType（dispatch_subagent 路由提示）。 */
  parentAgentWorkflowType?: string;
  /** 项目级权限上限（子 Agent grantedPermissions 收敛）。 */
  projectAllowedPermissions?: ToolPermission[];
  /** 路径授权审计摘要，由 ToolExecutionGateway 注入，供 trace / run report 串联。 */
  workspaceAccess?: Record<string, unknown>;
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
  /** 可选：在 zod 校验前对模型常见错参做保守归一化。 */
  normalizeInput?: (rawInput: unknown) => unknown;
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
export interface ToolRunResult {
  tool: string;
  durationMs: number;
  toolCallId?: string;
  executed: boolean;
  outcomeClass: ToolOutcomeClass;
  outcomeKind: string;
  message: string;
  recoverable: boolean;
  requiresUserAction?: boolean;
  suggestedNextActions?: SuggestedToolAction[];
  outcomePath?: string;
  outcomeCommand?: string;
  outcomeExitCode?: number;
  output?: unknown;
  ok: boolean;
  code?: ToolErrorCode;
  category?: ToolErrorCategory;
  risk?: StructuredToolRisk;
  error?: string;
}
