import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { AppContext } from "../../app/createAppContext.js";
import type { ApiResult } from "../../orchestrator/Orchestrator.js";

export async function handleDocsList(app: AppContext) {
  const docsDir = app.paths.docsDir;
  let files: string[] = [];
  try {
    files = await readdir(docsDir);
  } catch {
    return [];
  }
  const mdFiles = files
    .filter((f) => f.toLowerCase().endsWith(".md") && f.toLowerCase() !== "readme.md")
    .sort();

  return Promise.all(
    mdFiles.map(async (file) => {
      const slug = file.slice(0, -3);
      let title = slug;
      try {
        const content = await readFile(path.join(docsDir, file), "utf-8");
        const match = content.match(/^#\s+(.+)$/m);
        if (match?.[1]) title = match[1].trim();
      } catch {
        // 读取失败则用文件名作标题。
      }
      return { slug, title };
    }),
  );
}

export async function handleDocContent(app: AppContext, slug: string): Promise<ApiResult> {
  const docsDir = app.paths.docsDir;
  const safe = slug.replace(/[\\/]/g, "");
  const filePath = path.join(docsDir, `${safe}.md`);
  if (!filePath.startsWith(docsDir)) {
    return { status: 403, body: { error: "禁止访问" } };
  }
  try {
    const markdown = await readFile(filePath, "utf-8");
    return { status: 200, body: { slug: safe, markdown } };
  } catch {
    return { status: 404, body: { error: "文档不存在" } };
  }
}
