import type { ToolPermission } from "./permissions.js";

/** 一次工具调用的记录（用于回显执行过程）。 */
export interface AgentToolStep {
  iteration: number;
  toolCallId?: string;
  tool: string;
  input: unknown;
  permission?: ToolPermission;
  thought?: string;
  ok: boolean;
  output?: unknown;
  error?: string;
  durationMs?: number;
  blocked?: boolean;
}
