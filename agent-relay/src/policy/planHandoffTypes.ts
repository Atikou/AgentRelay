/** 计划→执行交接协议（与工具级 permissionRequest 分离）。 */
export const PLAN_HANDOFF_SCHEMA_VERSION = 1 as const;

export type PlanHandoffStatus = "pending" | "approved" | "rejected" | "expired";

export type PlanHandoffDecision = "approve" | "reject";

export type PlanHandoffVariant = "plan_only" | "plan_wait_approval" | "plan_then_execute";

export interface PlanHandoffPayload {
  schemaVersion: typeof PLAN_HANDOFF_SCHEMA_VERSION;
  id: string;
  planId: string;
  runId: string;
  sessionId?: string;
  status: PlanHandoffStatus;
  resumeMode: "implement";
  message: string;
  planVariant: PlanHandoffVariant;
  planMarkdown: string;
  createdAt: string;
  respondedAt?: string;
  decision?: PlanHandoffDecision;
}

export interface PlanHandoffRespondInput {
  decision: PlanHandoffDecision;
}
