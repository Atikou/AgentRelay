import type { LoopChatFn } from "../agent/AgentLoop.js";
import type { DelegatedTask } from "./delegatedTask.js";
import { buildDelegatedTaskSystemPrompt } from "./taskPrompt.js";
import { limitsToRunBudget } from "./delegatedTask.js";

/** 文件已预读时走单次分析：不要求 ReAct JSON 协议。 */
export async function runSingleShotReview(
  task: DelegatedTask,
  userContent: string,
  preloaded: string,
  chat: LoopChatFn,
  extras?: { sensitive?: boolean },
): Promise<string> {
  const budget = limitsToRunBudget(task.limits ?? {}, task.toolPolicy?.writeAllowed ?? false);
  const response = await chat(
    {
      messages: [
        {
          role: "system",
          content: [
            buildDelegatedTaskSystemPrompt(task, budget),
            "目标文件内容已在用户消息中给出。请直接输出分析结论（中文，可用 Markdown 列表）。",
            "禁止再要求调用工具；不要输出 JSON；不要重复粘贴整份源码。",
          ].join("\n"),
        },
        {
          role: "user",
          content: [userContent, preloaded].filter(Boolean).join("\n\n"),
        },
      ],
      temperature: 0.2,
    },
    { sensitive: extras?.sensitive },
  );
  return response.content.trim() || "（模型未返回内容）";
}
