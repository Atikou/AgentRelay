import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { buildTextPatch } from "../util/patch.js";
import { resolveInsideWorkspace } from "./pathSafe.js";
import type { Tool } from "./types.js";

/** read_file：读取工作区内文本文件。 */
export const readFileTool: Tool<
  z.ZodObject<{ path: z.ZodString; maxBytes: z.ZodOptional<z.ZodNumber> }>,
  { path: string; content: string; truncated: boolean }
> = {
  name: "read_file",
  description: "读取工作区内的文本文件内容。",
  permission: "read",
  hasSideEffect: false,
  inputSchema: z.object({
    path: z.string().min(1),
    maxBytes: z.number().int().positive().optional(),
  }),
  async execute(input, ctx) {
    const full = resolveInsideWorkspace(ctx.workspaceRoot, input.path);
    const buf = await fs.readFile(full);
    const limit = input.maxBytes ?? 200_000;
    const truncated = buf.byteLength > limit;
    const content = buf.subarray(0, limit).toString("utf-8");
    return { path: input.path, content, truncated };
  },
};

/** list_files：列出目录下的条目（不递归）。 */
export const listFilesTool: Tool<
  z.ZodObject<{ path: z.ZodDefault<z.ZodString> }>,
  { path: string; entries: Array<{ name: string; type: "file" | "dir" }> }
> = {
  name: "list_files",
  description: "列出工作区内某目录下的文件与子目录（不递归）。",
  permission: "read",
  hasSideEffect: false,
  inputSchema: z.object({
    path: z.string().default("."),
  }),
  async execute(input, ctx) {
    const full = resolveInsideWorkspace(ctx.workspaceRoot, input.path);
    const dirents = await fs.readdir(full, { withFileTypes: true });
    const entries = dirents
      .map((d) => ({ name: d.name, type: d.isDirectory() ? ("dir" as const) : ("file" as const) }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return { path: input.path, entries };
  },
};

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", ".cache", "data"]);

/** search_text：在工作区内按子串搜索（跳过常见大目录与二进制）。 */
export const searchTextTool: Tool<
  z.ZodObject<{
    query: z.ZodString;
    dir: z.ZodDefault<z.ZodString>;
    maxResults: z.ZodDefault<z.ZodNumber>;
  }>,
  { query: string; matches: Array<{ file: string; line: number; text: string }>; truncated: boolean }
> = {
  name: "search_text",
  description: "在工作区内按纯文本子串搜索，返回命中文件、行号与该行内容。",
  permission: "read",
  hasSideEffect: false,
  timeoutMs: 15_000,
  inputSchema: z.object({
    query: z.string().min(1),
    dir: z.string().default("."),
    maxResults: z.number().int().positive().max(500).default(100),
  }),
  async execute(input, ctx) {
    const root = resolveInsideWorkspace(ctx.workspaceRoot, input.dir);
    const matches: Array<{ file: string; line: number; text: string }> = [];
    let truncated = false;

    const walk = async (dir: string): Promise<void> => {
      if (matches.length >= input.maxResults) return;
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      for (const d of dirents) {
        if (ctx.signal?.aborted) return;
        if (matches.length >= input.maxResults) {
          truncated = true;
          return;
        }
        const abs = path.join(dir, d.name);
        if (d.isDirectory()) {
          if (IGNORED_DIRS.has(d.name)) continue;
          await walk(abs);
        } else {
          let content: string;
          try {
            const buf = await fs.readFile(abs);
            if (buf.includes(0)) continue; // 跳过二进制
            content = buf.toString("utf-8");
          } catch {
            continue;
          }
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i += 1) {
            if (lines[i]!.includes(input.query)) {
              matches.push({
                file: path.relative(ctx.workspaceRoot, abs),
                line: i + 1,
                text: lines[i]!.slice(0, 300),
              });
              if (matches.length >= input.maxResults) {
                truncated = true;
                break;
              }
            }
          }
        }
      }
    };

    await walk(root);
    return { query: input.query, matches, truncated };
  },
};

/** write_file：写入/覆盖工作区内文本文件（按需创建父目录）。 */
export const writeFileTool: Tool<
  z.ZodObject<{
    path: z.ZodString;
    content: z.ZodString;
    createDirs: z.ZodDefault<z.ZodBoolean>;
  }>,
  { path: string; bytesWritten: number; patchPreview: string; isNew: boolean }
> = {
  name: "write_file",
  description: "向工作区内写入（覆盖）文本文件，必要时创建父目录。",
  permission: "write",
  hasSideEffect: true,
  inputSchema: z.object({
    path: z.string().min(1),
    content: z.string(),
    createDirs: z.boolean().default(true),
  }),
  async execute(input, ctx) {
    const full = resolveInsideWorkspace(ctx.workspaceRoot, input.path);
    let oldContent: string | null = null;
    try {
      oldContent = await fs.readFile(full, "utf-8");
    } catch {
      oldContent = null;
    }
    const patchPreview = buildTextPatch(oldContent, input.content, input.path);
    if (input.createDirs) {
      await fs.mkdir(path.dirname(full), { recursive: true });
    }
    await fs.writeFile(full, input.content, "utf-8");
    return {
      path: input.path,
      bytesWritten: Buffer.byteLength(input.content, "utf-8"),
      patchPreview,
      isNew: oldContent === null,
    };
  },
};
