/**
 * 文本 patch 预览（写文件前供审计与确认）。
 */
export function buildTextPatch(
  oldContent: string | null,
  newContent: string,
  filePath: string,
): string {
  if (oldContent === null) {
    const lines = newContent.split("\n");
    const preview = lines.slice(0, 12).map((l) => `+ ${l}`).join("\n");
    const more = lines.length > 12 ? `\n+ ... (${lines.length - 12} more lines)` : "";
    return `--- /dev/null\n+++ ${filePath}\n@@ 新文件 @@\n${preview}${more}`;
  }
  if (oldContent === newContent) {
    return `（${filePath} 内容无变化）`;
  }
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const header = `--- ${filePath}\n+++ ${filePath}\n`;
  const removed = oldLines.slice(0, 6).map((l) => `- ${l}`).join("\n");
  const added = newLines.slice(0, 6).map((l) => `+ ${l}`).join("\n");
  const tail =
    oldLines.length > 6 || newLines.length > 6
      ? `\n... (共 ${oldLines.length} → ${newLines.length} 行，完整 diff 未展开)`
      : "";
  return `${header}@@ 变更摘要 @@\n${removed}\n${added}${tail}`;
}
