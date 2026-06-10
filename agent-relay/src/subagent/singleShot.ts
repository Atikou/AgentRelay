import type { LoopChatFn } from "../agent/AgentLoop.js";
import type { SubAgentRoleDefinition } from "./types.js";

/**
 * 文件已预读时走单次审查：不要求 JSON 协议，避免本地小模型在 ReAct 上空转。
 */
export async function runSingleShotReview(
  role: SubAgentRoleDefinition,
  task: string,
  preloaded: string,
  chat: LoopChatFn,
  extras?: { context?: string; sensitive?: boolean },
): Promise<string> {
  const response = await chat(
    {
      messages: [
        {
          role: "system",
          content: [
            role.systemPrompt,
            "目标文件内容已在用户消息中给出。请直接输出审查/分析结论（中文，可用 Markdown 列表）。",
            "禁止再要求调用工具；不要输出 JSON；不要重复粘贴整份源码。",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `任务：${task}`,
            preloaded,
            extras?.context ? `父 Agent 附加上下文：\n${extras.context}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
      temperature: 0.2,
    },
    { sensitive: extras?.sensitive },
  );
  return response.content.trim() || "（模型未返回内容）";
}
