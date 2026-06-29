export interface ToolAction {
  action: "tool";
  tool: string;
  input?: Record<string, unknown>;
  thought?: string;
}

export interface FinalAction {
  action: "final";
  answer: string;
}

export type AgentAction = ToolAction | FinalAction;

/** 去掉思考块噪声；Markdown 围栏可能出现在 final.answer 中，不能在解析前剥离。 */
export function stripModelNoise(content: string): string {
  let s = content;
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/<redacted_reasoning>[\s\S]*?<\/redacted_reasoning>/gi, "");
  return s.trim();
}

/** 从模型输出中提取可执行动作；final.answer 内部允许包含 Markdown/JSON 代码块。 */
export function parseAction(content: string): AgentAction | null {
  const cleaned = stripModelNoise(content);
  const direct = parseActionJson(cleaned);
  if (direct) return direct;
  for (const obj of extractJsonObjects(cleaned)) {
    const action = parseActionJson(obj);
    if (action) return action;
  }
  return null;
}

function parseActionJson(json: string): AgentAction | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed === "string" && parsed !== json) {
    return parseAction(parsed);
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (p.action === "final" && typeof p.answer === "string") {
    return { action: "final", answer: p.answer };
  }
  if (p.action === "tool" && typeof p.tool === "string") {
    return {
      action: "tool",
      tool: p.tool,
      input: (p.input as Record<string, unknown>) ?? {},
      thought: typeof p.thought === "string" ? p.thought : undefined,
    };
  }
  return null;
}

/** 扫描出所有平衡的 {...} 候选（忽略字符串内的花括号）。 */
function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    }
    else if (ch === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}
