import type { ToolPermission } from "../agent/permissions.js";
import type { SubAgentRoleDefinition, SubAgentRoleId } from "./types.js";

/** 内置只读子 Agent 角色（M5 第一版）。 */
export const SUB_AGENT_ROLES: Record<SubAgentRoleId, SubAgentRoleDefinition> = {
  code_review: {
    id: "code_review",
    title: "代码审查",
    description: "只读审查代码质量、潜在风险与改进建议，不修改文件。",
    allowedPermissions: ["read"],
    defaultMaxIterations: 16,
    defaultTimeoutMs: 180_000,
    singleShotWhenPreloaded: true,
    systemPrompt: [
      "你是 CodeReviewAgent，专职只读代码审查。",
      "只能使用 read/list/search 类只读工具查看工作区，禁止写文件或执行 shell。",
      "若上下文中已包含「预读文件」内容，直接基于其审查，不要再次 read_file 同一文件。",
      "审查流程：先锁定目标文件 → 必要时最多再查 1～2 个关联文件 → 给出 final。",
      "输出应包含：发现的问题（按严重度）、具体文件/行或函数、改进建议。",
      "严格遵守 ReAct JSON 协议：每次只输出一个 JSON，尽快给出 {\"action\":\"final\",...}，避免无效轮次。",
    ].join("\n"),
  },
  test_analyze: {
    id: "test_analyze",
    title: "测试分析",
    description: "只读分析测试输出、失败原因与修复方向，不执行命令。",
    allowedPermissions: ["read"],
    defaultMaxIterations: 8,
    defaultTimeoutMs: 120_000,
    singleShotWhenPreloaded: true,
    systemPrompt: [
      "你是 TestAnalyzeAgent，专职只读分析测试相关文本与日志。",
      "只能使用只读工具查看工作区内的测试输出、日志或相关源码。",
      "输出应包含：失败摘要、可能根因、建议下一步验证方式。",
      "不要运行测试命令；若缺少日志，说明需要父 Agent 提供什么信息。",
      "严格遵守 ReAct JSON 协议，尽快给出 final 答案。",
    ].join("\n"),
  },
};

export function getSubAgentRole(id: SubAgentRoleId): SubAgentRoleDefinition {
  const role = SUB_AGENT_ROLES[id];
  if (!role) throw new Error(`未知子 Agent 角色：${id}`);
  return role;
}

export function listSubAgentRoles(): SubAgentRoleDefinition[] {
  return Object.values(SUB_AGENT_ROLES);
}

/** 校验父 Agent 授予的权限是否为角色允许集的子集。 */
export function resolveGrantedPermissions(
  role: SubAgentRoleDefinition,
  requested?: ToolPermission[],
): ToolPermission[] {
  const grant = requested ?? role.allowedPermissions;
  for (const p of grant) {
    if (!role.allowedPermissions.includes(p)) {
      throw new Error(`角色「${role.title}」不允许授予权限：${p}`);
    }
  }
  return grant.length > 0 ? grant : role.allowedPermissions;
}
