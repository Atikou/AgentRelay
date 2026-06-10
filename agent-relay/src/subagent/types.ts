import type { AgentToolStep } from "../agent/AgentLoop.js";
import type { ToolPermission } from "../agent/permissions.js";

/** 第一版只读子 Agent 角色。 */
export type SubAgentRoleId = "code_review" | "test_analyze";

export type SubAgentStatus = "completed" | "failed" | "timeout" | "cancelled";

export interface SubAgentRoleDefinition {
  id: SubAgentRoleId;
  title: string;
  description: string;
  /** 父 Agent 可授予的权限（第一版固定只读）。 */
  allowedPermissions: ToolPermission[];
  systemPrompt: string;
  /** 该角色推荐的迭代上限（审查类任务通常需要更多步）。 */
  defaultMaxIterations: number;
  defaultTimeoutMs: number;
  /** 任务中文件已预读成功时，跳过 ReAct 循环，单次模型调用直接出结论。 */
  singleShotWhenPreloaded: boolean;
}

export interface SubAgentRunOptions {
  role: SubAgentRoleId;
  task: string;
  context?: string;
  parentTaskId?: string;
  /** 显式授予权限，必须是角色允许集的子集；默认等于角色权限。 */
  grantedPermissions?: ToolPermission[];
  maxIterations?: number;
  timeoutMs?: number;
  sensitive?: boolean;
}

export interface SubAgentRunResult {
  id: string;
  role: SubAgentRoleId;
  parentTaskId?: string;
  status: SubAgentStatus;
  answer: string;
  steps: AgentToolStep[];
  iterations: number;
  durationMs: number;
  grantedPermissions: ToolPermission[];
  error?: string;
}

export interface SubAgentBatchOptions {
  roles: SubAgentRoleId[];
  task: string;
  context?: string;
  parentTaskId?: string;
  grantedPermissions?: ToolPermission[];
  maxIterations?: number;
  timeoutMs?: number;
  sensitive?: boolean;
}

export interface SubAgentBatchResult {
  parentTaskId: string;
  results: SubAgentRunResult[];
  summary: string;
  durationMs: number;
}
