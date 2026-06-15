import type { RunBudget } from "../agent/RunPolicyTypes.js";

/** 模型能力需求标签（供 SmartModelRouter / DecisionEngine 提示）。 */
export type ModelCapability =
  | "reasoning"
  | "code"
  | "vision"
  | "summary"
  | "tool_use"
  | "long_context";

export type ModelQuality = "fast" | "balanced" | "strong";
export type ModelPrefer = "local" | "remote" | "auto";

/** 主 Agent 派发给子 Agent 的通用子任务包。 */
export interface DelegatedTask {
  id?: string;
  /** 本次子任务要完成的目标。 */
  goal: string;
  /** 主 Agent 给子 Agent 的具体执行说明。 */
  instructions: string;
  /** 当前任务的输入内容（日志、片段、用户摘录等）。 */
  input: string;
  /** 最小必要上下文；不继承主 Agent 全量历史。 */
  context?: DelegatedTaskContext;
  /** 执行限制。 */
  limits?: TaskLimits;
  /** 工具策略。 */
  toolPolicy?: ToolPolicy;
  /** 模型策略。 */
  modelPolicy?: ModelPolicy;
  /** 输出约束。 */
  outputContract?: OutputContract;
}

export interface DelegatedTaskContext {
  files?: string[];
  snippets?: string[];
  logs?: string[];
  previousResults?: string[];
  projectFacts?: string[];
}

export interface TaskLimits {
  maxIterations?: number;
  maxToolCalls?: number;
  maxFiles?: number;
  maxTokens?: number;
  maxRuntimeMs?: number;
}

export interface ToolPolicy {
  allowedTools: string[];
  writeAllowed: boolean;
  shellAllowed: boolean;
  requireApproval: boolean;
}

export interface ModelPolicy {
  prefer: ModelPrefer;
  allowRemoteEscalation: boolean;
  requiredCapabilities?: ModelCapability[];
  minQuality?: ModelQuality;
}

export type OutputFormat = "text" | "json" | "markdown";

export interface OutputContract {
  format: OutputFormat;
  requiredSections?: string[];
}

/** 子 Agent 结构化回收结果（给主 Agent 的压缩输出）。 */
export interface SubAgentStructuredResult {
  taskId: string;
  status: "success" | "partial" | "failed";
  summary: string;
  findings: string[];
  evidence?: Array<{ source: string; detail: string }>;
  risks?: string[];
  nextActions?: string[];
  usedModel?: string;
  usedTools?: string[];
  confidence?: number;
}

export const DEFAULT_READONLY_TOOL_POLICY: ToolPolicy = {
  allowedTools: [
    "read_file",
    "list_files",
    "search_text",
    "locate_relevant_files",
    "symbol_search",
    "context_pack",
    "git_status",
    "git_diff",
    "diff_file",
  ],
  writeAllowed: false,
  shellAllowed: false,
  requireApproval: false,
};

export const DEFAULT_PATCH_TOOL_POLICY: ToolPolicy = {
  allowedTools: [
    "read_file",
    "list_files",
    "search_text",
    "apply_patch",
    "write_file",
    "diff_file",
    "backup_file",
  ],
  writeAllowed: true,
  shellAllowed: false,
  requireApproval: true,
};

export const DEFAULT_READONLY_LIMITS: TaskLimits = {
  maxIterations: 16,
  maxToolCalls: 20,
  maxFiles: 20,
  maxRuntimeMs: 180_000,
};

export const DEFAULT_PATCH_LIMITS: TaskLimits = {
  maxIterations: 12,
  maxToolCalls: 16,
  maxFiles: 12,
  maxRuntimeMs: 240_000,
};

export const DEFAULT_READONLY_MODEL_POLICY: ModelPolicy = {
  prefer: "auto",
  allowRemoteEscalation: true,
  requiredCapabilities: [],
  minQuality: "balanced",
};

export const DEFAULT_PATCH_MODEL_POLICY: ModelPolicy = {
  prefer: "auto",
  allowRemoteEscalation: true,
  requiredCapabilities: ["code", "tool_use"],
  minQuality: "balanced",
};

export const DEFAULT_OUTPUT_CONTRACT: OutputContract = {
  format: "json",
  requiredSections: ["summary", "findings", "risks", "nextActions"],
};

/** 将 TaskLimits 转为 AgentLoop RunBudget。 */
export function limitsToRunBudget(limits: TaskLimits, writeAllowed = false): RunBudget {
  return {
    maxModelTurns: limits.maxIterations ?? 16,
    maxToolCalls: limits.maxToolCalls ?? 20,
    maxReadCalls: limits.maxFiles ?? 20,
    maxWriteCalls: writeAllowed ? Math.min(limits.maxToolCalls ?? 6, 6) : 0,
    maxShellCalls: 0,
    maxRuntimeMs: limits.maxRuntimeMs ?? 180_000,
  };
}

/** 合并部分 DelegatedTask 字段为完整任务（填充默认策略）。 */
export function normalizeDelegatedTask(partial: Partial<DelegatedTask> & Pick<DelegatedTask, "goal">): DelegatedTask {
  const writeAllowed = partial.toolPolicy?.writeAllowed ?? false;
  const defaultTool = writeAllowed ? DEFAULT_PATCH_TOOL_POLICY : DEFAULT_READONLY_TOOL_POLICY;
  const defaultLimits = writeAllowed ? DEFAULT_PATCH_LIMITS : DEFAULT_READONLY_LIMITS;
  const defaultModel = writeAllowed ? DEFAULT_PATCH_MODEL_POLICY : DEFAULT_READONLY_MODEL_POLICY;

  return {
    id: partial.id,
    goal: partial.goal.trim(),
    instructions: (partial.instructions ?? partial.goal).trim(),
    input: (partial.input ?? "").trim(),
    context: partial.context,
    limits: { ...defaultLimits, ...partial.limits },
    toolPolicy: { ...defaultTool, ...partial.toolPolicy, allowedTools: partial.toolPolicy?.allowedTools ?? defaultTool.allowedTools },
    modelPolicy: { ...defaultModel, ...partial.modelPolicy },
    outputContract: { ...DEFAULT_OUTPUT_CONTRACT, ...partial.outputContract },
  };
}
