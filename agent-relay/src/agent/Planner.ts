import type { ChatRequest, ModelResponse } from "../model/types.js";
import type { RouteOptions } from "../model/ModelRouter.js";
import { requiresConfirmation, type ToolPermission } from "./permissions.js";
import { PlanSchema, RawPlanSchema, type Plan } from "./types.js";

export type ChatFn = (request: ChatRequest, opts?: RouteOptions) => Promise<ModelResponse>;

const PLAN_SYSTEM_PROMPT = `你是一个编码 Agent 的「计划模式」。计划模式只做只读分析，绝不修改文件或执行命令。
根据用户目标，输出一个结构化执行计划。必须只输出 JSON，不要任何额外文字或解释，JSON 结构如下：
{
  "goal": "对目标的清晰复述",
  "scope": { "inScope": ["纳入范围的事项"], "outOfScope": ["明确不做的事项"] },
  "risks": ["潜在风险"],
  "dependencies": ["前置依赖"],
  "steps": [
    {
      "title": "步骤标题",
      "description": "做什么、怎么做",
      "requiredPermissions": ["read" | "write" | "shell" | "network" | "dangerous"],
      "needsConfirmation": true/false,
      "acceptance": "完成判定标准"
    }
  ]
}
规则：
- 涉及修改文件用 write，执行命令用 shell，联网用 network，删除/部署/推送等高风险用 dangerous。
- 凡是 write/shell/network/dangerous 的步骤，needsConfirmation 必须为 true。
- 只读分析步骤用 read，needsConfirmation 为 false。`;

/**
 * 计划模式：调用模型生成结构化计划。本类不执行任何副作用操作（只读）。
 */
export class Planner {
  constructor(private readonly chat: ChatFn) {}

  async generatePlan(goal: string, context?: string): Promise<Plan> {
    const userContent = context
      ? `目标：${goal}\n\n相关上下文：\n${context}`
      : `目标：${goal}`;

    const response = await this.chat(
      {
        messages: [
          { role: "system", content: PLAN_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        temperature: 0.2,
      },
      // 计划模式不需要工具；这里也不传 sensitive，由路由按默认策略选模型。
    );

    return normalizePlan(response.content, goal);
  }
}

/** 从模型文本中解析并规范化为合法 Plan。 */
export function normalizePlan(content: string, fallbackGoal: string): Plan {
  const json = extractJson(content);
  const raw = RawPlanSchema.parse(json);

  const steps = (raw.steps ?? []).map((s, index) => {
    const permissions = (s.requiredPermissions ?? ["read"]) as ToolPermission[];
    return {
      id: s.id ?? `step-${index + 1}`,
      title: s.title,
      description: s.description ?? "",
      requiredPermissions: permissions,
      needsConfirmation: s.needsConfirmation ?? requiresConfirmation(permissions),
      acceptance: s.acceptance,
      status: "pending" as const,
    };
  });

  return PlanSchema.parse({
    goal: raw.goal ?? fallbackGoal,
    scope: {
      inScope: raw.scope?.inScope ?? [],
      outOfScope: raw.scope?.outOfScope ?? [],
    },
    risks: raw.risks ?? [],
    dependencies: raw.dependencies ?? [],
    steps,
  });
}

/** 尽力从可能带代码围栏或前后缀文字的文本中提取 JSON。 */
function extractJson(content: string): unknown {
  const trimmed = content.trim();

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // 退化：截取第一个 { 到最后一个 }。
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("无法从模型输出中解析计划 JSON。");
  }
}
