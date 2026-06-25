import type { AgentIntentType } from "../IntentTypes.js";
import type { AgentRunMode } from "../RunPolicyTypes.js";

export type SideEffectKind = "read" | "write" | "shell";

export interface TaskCompletionContract {
  requiresSideEffect: boolean;
  requiredSideEffects: SideEffectKind[];
}

const SHELL_GOAL_RE =
  /安装依赖|npm\s+install|yarn\s+install|pnpm\s+install|运行项目|启动项目|执行测试|跑测试|npm\s+run|yarn\s+run|pnpm\s+run|启动服务|运行命令|打包项目/i;

const WRITE_GOAL_RE =
  /修改|改写|增强|优化|写入|创建文件|生成文件|apply|patch|实现方案|执行.*方案/i;

const READONLY_GOAL_RE =
  /是什么|什么是|介绍|解释|全局还是项目|审阅|审查|只读|不要改/i;

/** 仅从 goal 推断所需副作用（路由边界 / Final Guard 共用，不映射 workflow）。 */
export function inferRequiredSideEffectsFromGoal(goal: string): SideEffectKind[] {
  const text = goal.trim();
  if (!text) return [];
  if (READONLY_GOAL_RE.test(text) && !SHELL_GOAL_RE.test(text) && !WRITE_GOAL_RE.test(text)) {
    return [];
  }
  const required = new Set<SideEffectKind>();
  if (SHELL_GOAL_RE.test(text)) required.add("shell");
  if (WRITE_GOAL_RE.test(text) && !READONLY_GOAL_RE.test(text)) required.add("write");
  return [...required];
}

/** 推断任务完成所需副作用（intent 与 goal 合并，供 Final Guard 使用）。 */
export function buildTaskCompletionContract(input: {
  goal: string;
  intent: AgentIntentType;
  mode: AgentRunMode;
}): TaskCompletionContract {
  const goal = input.goal.trim();
  const required = new Set(inferRequiredSideEffectsFromGoal(goal));

  if (input.intent === "run" || input.intent === "verify" || input.intent === "debug") {
    required.add("shell");
  }
  if (input.intent === "edit" || input.intent === "refactor" || input.intent === "generate_file") {
    required.add("write");
  }

  if (
    (input.intent === "answer" || input.intent === "summarize" || input.intent === "search") &&
    !SHELL_GOAL_RE.test(goal) &&
    !WRITE_GOAL_RE.test(goal)
  ) {
    required.delete("shell");
    required.delete("write");
  }

  const requiredSideEffects = [...required];
  return {
    requiresSideEffect: requiredSideEffects.length > 0,
    requiredSideEffects,
  };
}
