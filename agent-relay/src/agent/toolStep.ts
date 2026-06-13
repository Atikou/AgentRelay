import type { ToolPermission } from "./permissions.js";
import type { StructuredToolRisk } from "../policy/ToolRiskAssessment.js";

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
  /** 结构化风险（确认门阻塞 / 策略拒绝时填充）。 */
  risk?: StructuredToolRisk;
}
