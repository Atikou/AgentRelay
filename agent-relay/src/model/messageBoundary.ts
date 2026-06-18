import type { ChatMessage } from "./types.js";

export function renderInternalToolMessage(message: ChatMessage): string {
  const header = [
    "AgentRelay runtime tool result.",
    "Source: tool",
    message.name ? `Tool: ${message.name}` : undefined,
    message.toolCallId ? `ToolCallId: ${message.toolCallId}` : undefined,
    "This is not a user message and not an assistant reply.",
  ].filter(Boolean);
  return `${header.join("\n")}\n\n${message.content}`;
}

export function normalizeMessagesForModelTransport(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool") return message;
    return {
      role: "system",
      content: renderInternalToolMessage(message),
    };
  });
}
