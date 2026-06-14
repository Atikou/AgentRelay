/** Agent 单轮模型决策事件（供 SSE model_turn 与测试台思考过程展示）。 */
export type AgentModelTurnPhase = "started" | "completed" | "parse_error";

export interface AgentModelTurnEvent {
  iteration: number;
  phase: AgentModelTurnPhase;
  action?: "tool" | "final";
  tool?: string;
  thought?: string;
  contentPreview?: string;
  clientName?: string;
  modelName?: string;
  latencyMs?: number;
}
