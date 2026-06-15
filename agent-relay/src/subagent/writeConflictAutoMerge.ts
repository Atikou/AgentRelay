import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildUnifiedDiff } from "../tools/file/diff.js";
import { hashContent } from "../tools/file/hash.js";
import type { ToolStorage } from "../tools/storage/ToolStorage.js";
import type { SubAgentRunResult, SubAgentWriteConflict, SubAgentWriteMergeAttempt } from "./types.js";
import { normalizeRelPath } from "./writeConflictMerge.js";
import {
  collectWriteFileCandidates,
  pickWriteFileCandidate,
  type WriteFilePickStrategy,
} from "./writeFileVersionPick.js";

const WRITE_TOOLS = new Set(["write_file", "apply_patch"]);

export interface AutoMergeWriteOptions {
  arbitrationSummary?: string;
  /** write_file 全量覆盖冲突选版策略；arbitration 无 WRITE_PICK 时回退 latest。 */
  writeFilePickStrategy?: WriteFilePickStrategy;
}

interface PatchOp {
  changeId?: string;
  tool: "apply_patch" | "write_file";
  search?: string;
  replace?: string;
  sortKey: number;
}

/** 在内存中对文本做唯一匹配的 search/replace（与 apply_patch 规则一致）。 */
export function applySearchReplaceInMemory(
  content: string,
  search: string,
  replace: string,
): { ok: true; content: string } | { ok: false; reason: string } {
  const first = content.indexOf(search);
  if (first === -1) return { ok: false, reason: "search 未找到" };
  const last = content.indexOf(search, first + search.length);
  if (last !== -1) return { ok: false, reason: "search 匹配多处" };
  return {
    ok: true,
    content: content.slice(0, first) + replace + content.slice(first + search.length),
  };
}

function collectPatchesForPath(results: SubAgentRunResult[], targetPath: string): PatchOp[] {
  const norm = normalizeRelPath(targetPath);
  const ops: PatchOp[] = [];
  for (let ri = 0; ri < results.length; ri++) {
    const result = results[ri]!;
    if (result.status !== "completed") continue;
    for (const step of result.steps) {
      if (!step.ok || !WRITE_TOOLS.has(step.tool)) continue;
      const input = step.input as Record<string, unknown> | undefined;
      const output = step.output as Record<string, unknown> | undefined;
      const stepPath =
        typeof input?.path === "string" ? normalizeRelPath(input.path) : undefined;
      if (stepPath !== norm) continue;
      const changeId = typeof output?.changeId === "string" ? output.changeId : undefined;
      if (step.tool === "apply_patch") {
        const search = typeof input?.search === "string" ? input.search : undefined;
        const replace = typeof input?.replace === "string" ? input.replace : "";
        if (!search) continue;
        ops.push({
          changeId,
          tool: "apply_patch",
          search,
          replace,
          sortKey: ri * 1000 + step.iteration,
        });
      } else if (step.tool === "write_file") {
        ops.push({
          changeId,
          tool: "write_file",
          sortKey: ri * 1000 + step.iteration,
        });
      }
    }
  }
  ops.sort((a, b) => a.sortKey - b.sortKey);
  return ops;
}

async function loadBaseContent(
  storage: ToolStorage,
  changeIds: string[],
): Promise<{ content: string; changeId: string } | null> {
  const records = changeIds
    .map((id) => storage.getFileChange(id))
    .filter((r): r is NonNullable<typeof r> => r != null && !!r.backupPath)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const first = records[0];
  if (!first?.backupPath) return null;
  const content = await storage.readBackupContent(first.backupPath);
  return { content, changeId: first.id };
}

async function persistResolvedContent(
  storage: ToolStorage,
  workspaceRoot: string,
  pathRel: string,
  content: string,
  toolName: string,
): Promise<string> {
  const fullPath = path.join(workspaceRoot, pathRel);
  await mkdir(path.dirname(fullPath), { recursive: true });

  const currentOnDisk = await readFile(fullPath, "utf-8").catch(() => null);
  const beforeHash = currentOnDisk != null ? hashContent(currentOnDisk) : undefined;
  const afterHash = hashContent(content);
  const diff = buildUnifiedDiff(currentOnDisk ?? "", content, pathRel);
  const changeId = randomUUID();

  const batch = await storage.createBackupBatch(workspaceRoot, [pathRel], {
    reason: toolName,
    sha256ByPath: beforeHash != null ? new Map([[pathRel, beforeHash]]) : undefined,
  });
  const backupPath = batch.files[0]?.backupPath;

  await writeFile(fullPath, content, "utf-8");
  storage.insertFileChange({
    id: changeId,
    toolName,
    path: pathRel,
    beforeHash,
    afterHash,
    backupPath,
    diff,
  });
  return changeId;
}

async function attemptPickWriteFileVersion(
  storage: ToolStorage,
  workspaceRoot: string,
  conflict: SubAgentWriteConflict,
  results: SubAgentRunResult[],
  mergeOptions?: AutoMergeWriteOptions,
): Promise<SubAgentWriteMergeAttempt> {
  const pathRel = conflict.path;
  const strategy = mergeOptions?.writeFilePickStrategy ?? "arbitration";
  const candidates = collectWriteFileCandidates(results, pathRel, (changeId) => {
    return storage.getFileChange(changeId)?.createdAt;
  });

  const picked = pickWriteFileCandidate(
    candidates,
    conflict,
    strategy,
    mergeOptions?.arbitrationSummary,
  );
  if ("manual" in picked) {
    return {
      path: pathRel,
      status: "manual_required",
      reason: picked.reason,
      appliedPatches: 0,
    };
  }

  const changeId = await persistResolvedContent(
    storage,
    workspaceRoot,
    pathRel,
    picked.candidate.content,
    "subagent_write_file_pick",
  );

  return {
    path: pathRel,
    status: "merged",
    changeId,
    pickedChangeId: picked.candidate.changeId,
    pickedTaskId: picked.candidate.taskId,
    pickStrategy: picked.strategy,
    reason: `write_file 选版：${picked.reason}`,
    appliedPatches: 0,
  };
}

/** 对单一路径尝试自动合并或选版。 */
export async function attemptAutoMergeWriteConflict(
  storage: ToolStorage,
  workspaceRoot: string,
  conflict: SubAgentWriteConflict,
  results: SubAgentRunResult[],
  mergeOptions?: AutoMergeWriteOptions,
): Promise<SubAgentWriteMergeAttempt> {
  const pathRel = conflict.path;
  const patches = collectPatchesForPath(results, pathRel);

  if (patches.length < 2) {
    return { path: pathRel, status: "skipped", reason: "补丁步骤不足", appliedPatches: 0 };
  }

  const writeFileOps = patches.filter((p) => p.tool === "write_file");
  const applyOps = patches.filter((p) => p.tool === "apply_patch");

  if (writeFileOps.length > 0 && applyOps.length > 0) {
    return {
      path: pathRel,
      status: "manual_required",
      reason: "write_file 与 apply_patch 混用，需人工或仲裁处理",
      appliedPatches: 0,
    };
  }

  if (writeFileOps.length > 1 && applyOps.length === 0) {
    return attemptPickWriteFileVersion(storage, workspaceRoot, conflict, results, mergeOptions);
  }

  const base = await loadBaseContent(storage, conflict.changeIds);
  if (!base) {
    return {
      path: pathRel,
      status: "manual_required",
      reason: "缺少 changeId 备份，无法三路合并",
      appliedPatches: 0,
    };
  }

  let content = base.content;
  let applied = 0;
  for (const op of applyOps) {
    if (!op.search) continue;
    const result = applySearchReplaceInMemory(content, op.search, op.replace ?? "");
    if (!result.ok) {
      return {
        path: pathRel,
        status: "manual_required",
        reason: `补丁重叠或上下文已变：${result.reason}（changeId=${op.changeId ?? "?"})`,
        appliedPatches: applied,
      };
    }
    content = result.content;
    applied += 1;
  }

  const changeId = await persistResolvedContent(
    storage,
    workspaceRoot,
    pathRel,
    content,
    "subagent_auto_merge",
  );

  return {
    path: pathRel,
    status: "merged",
    changeId,
    reason: `三路合并：以 changeId=${base.changeId} 备份为基线，顺序应用 ${applied} 个 apply_patch`,
    appliedPatches: applied,
  };
}

/** 对 aggregate.writeConflicts 逐条尝试自动合并或选版。 */
export async function attemptAutoMergeWriteConflicts(
  storage: ToolStorage,
  workspaceRoot: string,
  conflicts: SubAgentWriteConflict[],
  results: SubAgentRunResult[],
  mergeOptions?: AutoMergeWriteOptions,
): Promise<SubAgentWriteMergeAttempt[]> {
  const attempts: SubAgentWriteMergeAttempt[] = [];
  for (const conflict of conflicts) {
    attempts.push(
      await attemptAutoMergeWriteConflict(storage, workspaceRoot, conflict, results, mergeOptions),
    );
  }
  return attempts;
}

export function formatWriteMergeSummary(attempts: SubAgentWriteMergeAttempt[]): string {
  if (attempts.length === 0) return "";
  const lines = ["## 写入冲突自动合并"];
  for (const attempt of attempts) {
    const tag =
      attempt.status === "merged"
        ? "已合并"
        : attempt.status === "manual_required"
          ? "需人工"
          : "跳过";
    const changeHint = attempt.changeId ? ` → changeId=${attempt.changeId}` : "";
    const pickHint =
      attempt.pickedChangeId != null
        ? `（源 changeId=${attempt.pickedChangeId}${attempt.pickedTaskId ? `，task=${attempt.pickedTaskId.slice(0, 8)}` : ""}）`
        : "";
    lines.push(`- **${attempt.path}**（${tag}）：${attempt.reason}${pickHint}${changeHint}`);
  }
  return lines.join("\n");
}
