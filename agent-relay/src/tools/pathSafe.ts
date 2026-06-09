import path from "node:path";

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
