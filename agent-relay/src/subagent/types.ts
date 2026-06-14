import type { AgentToolStep } from "../agent/toolStep.js";
import type { ToolPermission } from "../agent/permissions.js";
import type { RunBudget } from "../agent/RunPolicyTypes.js";

/** 第一版子 Agent 角色；`patch_worker` 为父 Agent 显式授权下的写权限子 Agent。 */
export type SubAgentRoleId = "code_review" | "test_analyze" | "patch_worker";

export type SubAgentStatus = "completed" | "failed" | "timeout" | "cancelled";

export interface SubAgentRoleDefinition {
  id: SubAgentRoleId;
  title: string;
  description: string;
  /** 父 Agent 可授予的权限（须为角色允许集的子集）。 */
  allowedPermissions: ToolPermission[];
  systemPrompt: string;
  /** 该角色推荐的运行预算。 */
  defaultBudget: RunBudget;
  defaultTimeoutMs: number;
  /** 任务中文件已预读成功时，跳过 ReAct 循环，单次模型调用直接出结论。 */
  singleShotWhenPreloaded: boolean;
  /** 为 true 时父 Agent 必须显式传入 grantedPermissions（如 patch_worker 须含 write）。 */
  requiresExplicitGrant?: boolean;
  /** 显式授予时必须包含的权限（如 patch_worker 须含 write）。 */
  requiredGrantIncludes?: ToolPermission[];
}

export interface SubAgentRunOptions {
  role: SubAgentRoleId;
  task: string;
  context?: string;
  parentTaskId?: string;
  /** 显式授予权限，必须是角色允许集的子集；默认等于角色权限。 */
  grantedPermissions?: ToolPermission[];
  budget?: Partial<RunBudget>;
  timeoutMs?: number;
  sensitive?: boolean;
  /** 当前派生深度（主 Agent 为 0）；用于有界递归门控。 */
  dispatchDepth?: number;
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
  budget?: Partial<RunBudget>;
  timeoutMs?: number;
  sensitive?: boolean;
  dispatchDepth?: number;
  /** 存在文本/写入冲突时调用模型仲裁复核。 */
  arbitrateConflicts?: boolean;
}

export interface SubAgentConflict {
  topic: string;
  roles: SubAgentRoleId[];
  excerpts: Array<{ role: SubAgentRoleId; text: string }>;
  reason: string;
}

/** 多个子 Agent 写入同一文件时检测到的补丁级冲突。 */
export interface SubAgentWriteConflict {
  path: string;
  roles: SubAgentRoleId[];
  changeIds: string[];
  reason: string;
}

export interface SubAgentArbitration {
  applied: boolean;
  summary: string;
  skippedReason?: string;
}

export interface SubAgentAggregate {
  status: "completed" | "partial" | "conflict" | "failed";
  completed: number;
  failed: number;
  timedOut: number;
  commonFindings: string[];
  conflicts: SubAgentConflict[];
  writeConflicts: SubAgentWriteConflict[];
  arbitration?: SubAgentArbitration;
  mergedAnswer: string;
}

export interface SubAgentBatchResult {
  parentTaskId: string;
  results: SubAgentRunResult[];
  summary: string;
  aggregate: SubAgentAggregate;
  durationMs: number;
}
