/** 单次对话 SSE 事件（`POST /api/chat/stream`）。 */
export type ChatStreamEvent =
  | { type: "run_start"; runId: string; sessionId?: string }
  | { type: "token"; delta: string }
  | { type: "done"; runId: string; sessionId?: string; content: string; clientName?: string; modelName?: string; location?: string; latencyMs?: number; routerDecision?: unknown; cancelled?: boolean }
  | { type: "error"; error: string; runId: string };
