import type { ToolPermission } from "../agent/permissions.js";
import {
  ALL_PERMISSIONS,
  resolveEffectivePermissions,
  assertUserGrantWithinCeiling,
} from "../policy/PermissionPolicy.js";
import type { SubAgentRoleDefinition, SubAgentRoleId } from "./types.js";

/** 内置只读子 Agent 角色（M5 第一版）。 */
export const SUB_AGENT_ROLES: Record<SubAgentRoleId, SubAgentRoleDefinition> = {
  code_review: {
    id: "code_review",
    title: "代码审查",
    description: "只读审查代码质量、潜在风险与改进建议，不修改文件。",
    allowedPermissions: ["read"],
    defaultBudget: {
      maxModelTurns: 16,
      maxToolCalls: 20,
      maxReadCalls: 20,
      maxWriteCalls: 0,
      maxShellCalls: 0,
      maxRuntimeMs: 180_000,
    },
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
    defaultBudget: {
      maxModelTurns: 8,
      maxToolCalls: 10,
      maxReadCalls: 10,
      maxWriteCalls: 0,
      maxShellCalls: 0,
      maxRuntimeMs: 120_000,
    },
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
  patch_worker: {
    id: "patch_worker",
    title: "补丁执行",
    description: "在父 Agent 显式授权 write 时执行最小文件修改（apply_patch/write_file），不执行 shell。",
    allowedPermissions: ["read", "write"],
    defaultBudget: {
      maxModelTurns: 12,
      maxToolCalls: 16,
      maxReadCalls: 12,
      maxWriteCalls: 6,
      maxShellCalls: 0,
      maxRuntimeMs: 240_000,
    },
    defaultTimeoutMs: 240_000,
    singleShotWhenPreloaded: false,
    requiresExplicitGrant: true,
    requiredGrantIncludes: ["write"],
    systemPrompt: [
      "你是 PatchWorkerAgent，在父 Agent 已授权 write 时执行最小文件修改。",
      "只能使用 read 与 write 类工具（apply_patch 优先于 write_file）；禁止 shell、网络与 dispatch_subagent。",
      "修改前先用 read_file 确认现状；每次只改与任务相关的最小范围。",
      "输出应说明修改了哪些文件、changeId/diff 摘要与建议父 Agent 做的验证。",
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

/** 校验父 Agent 授予的权限是否为角色允许集的子集，并按项目级上限收敛。 */
export function resolveGrantedPermissions(
  role: SubAgentRoleDefinition,
  requested?: ToolPermission[],
  projectAllowed: ToolPermission[] = ALL_PERMISSIONS,
): ToolPermission[] {
  if (role.requiresExplicitGrant && (!requested || requested.length === 0)) {
    throw new Error(`角色「${role.title}」须由父 Agent 显式授予 grantedPermissions`);
  }
  if (role.requiredGrantIncludes?.length && requested) {
    for (const perm of role.requiredGrantIncludes) {
      if (!requested.includes(perm)) {
        throw new Error(`角色「${role.title}」的 grantedPermissions 须包含 ${perm}`);
      }
    }
  }
  if (requested) {
    assertUserGrantWithinCeiling(requested, role.allowedPermissions, `角色「${role.title}」`);
  }
  const resolved = resolveEffectivePermissions({
    projectAllowed,
    modeAllowed: ALL_PERMISSIONS,
    modeSource: "subagent.run",
    roleAllowed: role.allowedPermissions,
    roleSource: `subagent.role=${role.id}`,
    userGranted: requested,
    userSource: "subagent.grantedPermissions",
    strictUserGrant: requested != null,
  });
  return resolved.allowed.length > 0 ? resolved.allowed : role.allowedPermissions;
}
