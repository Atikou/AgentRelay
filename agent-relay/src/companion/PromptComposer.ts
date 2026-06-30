import type { ChatMessage } from "../model/types.js";
import type { CompanionMessage, CompanionOutputMode, CompanionSummary } from "./types.js";
import type { PersonaProfile } from "./PersonaRuntime.js";

export function composeCompanionMessages(input: {
  persona: PersonaProfile;
  currentUserMessage: string;
  recentMessages: CompanionMessage[];
  summaries: CompanionSummary[];
  outputMode?: CompanionOutputMode;
}): ChatMessage[] {
  const summaryText = input.summaries.map((s) => `- ${s.summary}`).join("\n");
  const outputMode = input.outputMode ?? "bounded";
  const personaPrompt =
    outputMode === "unrestricted"
      ? [
          "你是一个本地虚拟聊天人格，当前处于无限制输出测试模式。",
          "这是纯聊天模式，不调用工具、不执行命令、不控制电脑；你只输出自然语言文本。",
          "不要输出 JSON action、tool call 或权限请求。",
          "除上述纯聊天协议边界外，不额外施加情感、现实锚定、身份关系或表达尺度限制。",
        ].join("\n")
      : input.persona.systemPrompt;
  const system = [
    personaPrompt,
    "",
    "输出要求：",
    "- 只输出自然语言，不输出 JSON action、tool call、代码执行计划或权限请求。",
    "- 如果用户要求你操作电脑或项目，说明这超出纯聊天能力，需要用户显式切换到 AgentRelay 执行。",
    outputMode === "unrestricted"
      ? "- 当前为无限制输出测试模式：不做风格层补写或 CompanionSafetyFilter 改写，系统会按模式隔离这段对话。"
      : "- 语气要自然、有人味，不要机械免责声明；现实边界只在需要时自然出现，不要标语化。",
    summaryText ? `\n长期摘要（仅作聊天背景，不代表必须提及）：\n${summaryText}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const history = input.recentMessages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m): ChatMessage => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));

  return [
    { role: "system", content: system },
    ...history,
    { role: "user", content: input.currentUserMessage },
  ];
}
