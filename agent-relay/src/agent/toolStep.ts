import type { ToolPermission } from "./permissions.js";
import type { PermissionConfirmationRequest } from "../policy/PermissionGuard.js";
import type { StructuredToolRisk } from "../policy/ToolRiskAssessment.js";
import type { ToolResultLayers } from "../util/toolResultLayers.js";

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
  /** 工具结果三层：raw / modelVisible / userDisplay。 */
  resultLayers?: ToolResultLayers;
  error?: string;
  durationMs?: number;
  blocked?: boolean;
  /** 工作流阶段门控阻塞（proposal/analysis 未完成时尝试写入）。 */
  workflowPhaseBlocked?: boolean;
  /** 结构化风险（确认门阻塞 / 策略拒绝时填充）。 */
  risk?: StructuredToolRisk;
  /** 结构化确认/拒绝说明，供 UI、SSE 与审计展示。 */
  confirmationRequest?: PermissionConfirmationRequest;
}
