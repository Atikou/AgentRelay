import { stat } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_IGNORED_DIRS } from "./constants.js";

/**
 * 把相对/绝对路径解析为工作区内的绝对路径；越界则抛错。
 *
 * 用 path.relative 判断，避免 startsWith 在大小写/前缀场景下被绕过。
 */
export function resolveInsideWorkspace(workspaceRoot: string, target: string): string {
  const root = path.resolve(workspaceRoot);
  const full = path.resolve(root, target);
  const rel = path.relative(root, full);
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (!inside) {
    throw new Error(`禁止访问工作区之外的路径：${target}`);
  }
  return full;
}

/** 规范别名。 */
export const assertInsideWorkspace = resolveInsideWorkspace;

/** 对已存在路径做 realpath，防止符号链接逃逸。 */
export async function resolveInsideWorkspaceAsync(
  workspaceRoot: string,
  target: string,
): Promise<string> {
  const full = resolveInsideWorkspace(workspaceRoot, target);
  try {
    const { realpath } = await import("node:fs/promises");
    const resolved = await realpath(full);
    const root = path.resolve(workspaceRoot);
    const rel = path.relative(root, resolved);
    const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    if (!inside) {
      throw new Error(`禁止访问工作区之外的路径（符号链接）：${target}`);
    }
    return resolved;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return full;
    throw err;
  }
}

/** 目录名是否在默认忽略列表中。 */
export function shouldIgnoreDir(name: string, extra?: Set<string>): boolean {
  if (extra?.has(name)) return true;
  return DEFAULT_IGNORED_DIRS.has(name);
}

/** 目标必须是普通文件。 */
export async function assertIsFile(fullPath: string): Promise<void> {
  const s = await stat(fullPath);
  if (!s.isFile()) throw new Error(`不是文件：${fullPath}`);
}
