import type { ChatRole } from "../model/types.js";

/** 消息语义（与 role 正交）。 */
export type MessageKind =
  | "user_input"
  | "tool_action"
  | "final_answer"
  | "raw_model_final"
  | "tool_result"
  | "workflow_event"
  | "guard_notice";

export type MessageSource = "user" | "model" | "guard" | "tool" | "workflow" | "system";

export interface MessageEnvelope {
  messageKind: MessageKind;
  uiVisible: boolean;
  trusted: boolean;
  source: MessageSource;
  runId?: string;
  ledgerBacked?: boolean;
  outcomeClass?: string;
  outcomeKind?: string;
}

export interface MessageEnvelopeInput {
  role?: ChatRole | string;
  messageKind?: MessageKind;
  uiVisible?: boolean;
  trusted?: boolean;
  source?: MessageSource;
  runId?: string;
  content?: string;
  ledgerBacked?: boolean;
  outcomeClass?: string;
  outcomeKind?: string;
}

export function resolveMessageEnvelope(input: MessageEnvelopeInput): MessageEnvelope {
  if (input.messageKind) {
    return {
      messageKind: input.messageKind,
      uiVisible: input.uiVisible ?? defaultUiVisible(input.messageKind),
      trusted: input.trusted ?? defaultTrusted(input.messageKind),
      source: input.source ?? defaultSource(input.messageKind),
      runId: input.runId,
      ledgerBacked: input.ledgerBacked,
      outcomeClass: input.outcomeClass,
      outcomeKind: input.outcomeKind,
    };
  }
  return inferEnvelopeFromLegacy(input.role ?? "system", input.content);
}

export function defaultUiVisible(kind: MessageKind): boolean {
  return kind === "user_input" || kind === "final_answer";
}

export function defaultTrusted(kind: MessageKind): boolean {
  return kind === "user_input" || kind === "final_answer" || kind === "tool_result";
}

export function defaultSource(kind: MessageKind): MessageSource {
  switch (kind) {
    case "user_input":
      return "user";
    case "tool_action":
    case "raw_model_final":
      return "model";
    case "final_answer":
      return "model";
    case "tool_result":
      return "tool";
    case "guard_notice":
      return "guard";
    case "workflow_event":
      return "workflow";
    default:
      return "system";
  }
}

/** 旧数据无 envelope 字段时的启发式推断。 */
export function inferEnvelopeFromLegacy(role: string, content?: string): MessageEnvelope {
  if (role === "user") {
    return {
      messageKind: "user_input",
      uiVisible: true,
      trusted: true,
      source: "user",
    };
  }
  if (role === "tool") {
    return {
      messageKind: "tool_result",
      uiVisible: false,
      trusted: true,
      source: "tool",
    };
  }
  if (role === "system") {
    return {
      messageKind: "workflow_event",
      uiVisible: false,
      trusted: false,
      source: "workflow",
    };
  }
  if (role === "assistant") {
    const action = tryParseAgentAction(content);
    if (action?.action === "tool") {
      return {
        messageKind: "tool_action",
        uiVisible: false,
        trusted: false,
        source: "model",
      };
    }
    if (action?.action === "final") {
      return {
        messageKind: "raw_model_final",
        uiVisible: false,
        trusted: false,
        source: "model",
      };
    }
    return {
      messageKind: "final_answer",
      uiVisible: true,
      trusted: false,
      source: "model",
    };
  }
  return {
    messageKind: "workflow_event",
    uiVisible: false,
    trusted: false,
    source: "system",
  };
}

export function isContextTrustedMessage(envelope: MessageEnvelope): boolean {
  if (envelope.messageKind === "user_input") return true;
  if (envelope.messageKind === "final_answer") return envelope.trusted;
  if (envelope.messageKind === "tool_result") return envelope.trusted;
  if (envelope.messageKind === "guard_notice") return envelope.trusted;
  return false;
}

export function isUiChatBubble(envelope: MessageEnvelope, role: string): boolean {
  if (role === "user") return true;
  if (envelope.messageKind === "final_answer" && envelope.uiVisible) return true;
  return false;
}

function tryParseAgentAction(content?: string): { action: string } | null {
  if (!content?.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(content) as { action?: string };
    if (parsed && typeof parsed.action === "string") return { action: parsed.action };
  } catch {
    /* ignore */
  }
  return null;
}
