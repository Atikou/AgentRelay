import type { AgentRunResult, AgentToolStep } from "../agent/AgentLoop.js";

/** SSE 事件：与 `event:` 字段同名。 */
export type AgentStreamEvent =
  | { type: "run_start"; runId: string; taskId: string; sessionId?: string }
  | { type: "step"; step: AgentToolStep }
  | ({ type: "done" } & AgentRunResult & { runId: string; taskId: string })
  | { type: "error"; error: string; runId: string; taskId: string };
