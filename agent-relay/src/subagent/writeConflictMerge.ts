import type { AgentToolStep } from "../agent/toolStep.js";
import type { SubAgentRoleId, SubAgentRunResult, SubAgentWriteConflict } from "./types.js";

export type { SubAgentWriteConflict };

const WRITE_TOOLS = new Set(["write_file", "apply_patch"]);

/** 从子 Agent 工具步骤中提取成功写入的文件路径。 */
export function extractWritePathsFromSteps(steps: AgentToolStep[]): Array<{ path: string; changeId?: string }> {
  const out: Array<{ path: string; changeId?: string }> = [];
  for (const step of steps) {
    if (!step.ok || !WRITE_TOOLS.has(step.tool)) continue;
    const input = step.input as Record<string, unknown> | undefined;
    const output = step.output as Record<string, unknown> | undefined;
    const path =
      typeof input?.path === "string"
        ? input.path
        : typeof output?.path === "string"
          ? output.path
          : undefined;
    if (!path) continue;
    const changeId = typeof output?.changeId === "string" ? output.changeId : undefined;
    out.push({ path: normalizeRelPath(path), changeId });
  }
  return out;
}

/** 检测多个子 Agent 是否写入了同一文件（按子 Agent 运行实例计数，不限于不同角色）。 */
export function detectWriteConflicts(results: SubAgentRunResult[]): SubAgentWriteConflict[] {
  const byPath = new Map<
    string,
    { resultIds: Set<string>; roles: SubAgentRoleId[]; changeIds: string[] }
  >();
  for (const result of results) {
    if (result.status !== "completed") continue;
    for (const { path, changeId } of extractWritePathsFromSteps(result.steps)) {
      const entry = byPath.get(path) ?? { resultIds: new Set<string>(), roles: [], changeIds: [] };
      if (!entry.resultIds.has(result.id)) {
        entry.resultIds.add(result.id);
        entry.roles.push(result.role);
      }
      if (changeId) entry.changeIds.push(changeId);
      byPath.set(path, entry);
    }
  }
  const conflicts: SubAgentWriteConflict[] = [];
  for (const [path, entry] of byPath) {
    if (entry.resultIds.size < 2) continue;
    conflicts.push({
      path,
      roles: entry.roles,
      changeIds: entry.changeIds,
      reason: `${entry.resultIds.size} 个子 Agent 运行写入了同一文件，需父 Agent 或仲裁合并`,
    });
  }
  return conflicts.slice(0, 20);
}

function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}
