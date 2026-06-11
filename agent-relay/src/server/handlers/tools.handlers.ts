import { readFile } from "node:fs/promises";

import type { AppContext } from "../../app/createAppContext.js";
import type { ApiResult } from "../../orchestrator/Orchestrator.js";
import { ALL_PERMISSIONS, CONFIRMATION_REQUIRED } from "../../policy/index.js";
import { buildUnifiedDiff, truncateDiff } from "../../tools/file/diff.js";
import { hashContent } from "../../tools/file/hash.js";
import { resolveInsideWorkspace, resolveInsideWorkspaceAsync, assertIsFile } from "../../tools/pathSafe.js";
import { checkCommandRisk } from "../../tools/risk.js";

export function handleToolsList(app: AppContext) {
  return { workspaceRoot: app.workspaceRoot, tools: app.registry.list() };
}

type ToolPreview =
  | {
      kind: "write_file";
      path: string;
      isNew: boolean;
      beforeHash?: string;
      patchPreview: string;
      truncated: boolean;
    }
  | {
      kind: "apply_patch";
      path: string;
      beforeHash: string;
      patchPreview: string;
      truncated: boolean;
    }
  | {
      kind: "shell_run";
      command: string;
      risk: ReturnType<typeof checkCommandRisk>;
    };

export async function buildToolPreview(
  app: AppContext,
  name: string,
  input: unknown,
): Promise<ToolPreview | undefined> {
  const { workspaceRoot } = app;

  if (name === "write_file") {
    const data = input as {
      path: string;
      content: string;
      createOnly?: boolean;
      overwrite?: boolean;
      expectedHash?: string;
    };
    const full = resolveInsideWorkspace(workspaceRoot, data.path);
    let oldContent = "";
    let isNew = false;
    let beforeHash: string | undefined;
    try {
      oldContent = await readFile(full, "utf-8");
      beforeHash = hashContent(oldContent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      isNew = true;
    }
    if (!isNew && data.createOnly) {
      throw new Error(`文件已存在且 createOnly=true：${data.path}`);
    }
    if (!isNew && data.overwrite === false) {
      throw new Error(`文件已存在且 overwrite=false：${data.path}`);
    }
    if (data.expectedHash != null && beforeHash != null && beforeHash !== data.expectedHash) {
      throw new Error(`expectedHash 不匹配，文件可能已被修改：${data.path}`);
    }
    const { diff, truncated } = truncateDiff(buildUnifiedDiff(oldContent, data.content, data.path));
    return {
      kind: "write_file",
      path: data.path,
      isNew,
      beforeHash,
      patchPreview: diff,
      truncated,
    };
  }

  if (name === "apply_patch") {
    const data = input as {
      path: string;
      search: string;
      replace: string;
      expectedHash?: string;
    };
    const full = await resolveInsideWorkspaceAsync(workspaceRoot, data.path);
    await assertIsFile(full);
    const oldContent = await readFile(full, "utf-8");
    const beforeHash = hashContent(oldContent);
    if (data.expectedHash != null && beforeHash !== data.expectedHash) {
      throw new Error(`expectedHash 不匹配：${data.path}`);
    }
    const first = oldContent.indexOf(data.search);
    if (first === -1) throw new Error(`search 未找到：${data.path}`);
    const last = oldContent.indexOf(data.search, first + data.search.length);
    if (last !== -1) throw new Error(`search 匹配多处：${data.path}，拒绝修改`);
    const newContent =
      oldContent.slice(0, first) + data.replace + oldContent.slice(first + data.search.length);
    const { diff, truncated } = truncateDiff(buildUnifiedDiff(oldContent, newContent, data.path));
    return { kind: "apply_patch", path: data.path, beforeHash, patchPreview: diff, truncated };
  }

  if (name === "shell_run") {
    const data = input as { command?: string };
    const command = (data.command ?? "").trim();
    if (!command) return undefined;
    return { kind: "shell_run", command, risk: checkCommandRisk(command) };
  }

  return undefined;
}

export async function handleToolRun(app: AppContext, body: unknown): Promise<ApiResult> {
  const payload = (body ?? {}) as { name?: string; input?: unknown; confirm?: boolean };
  const name = (payload.name ?? "").trim();
  if (!name) return { status: 400, body: { error: "name 不能为空" } };

  const tool = app.registry.get(name);
  if (!tool) return { status: 404, body: { error: `未知工具：${name}` } };

  const parsed = tool.inputSchema.safeParse(payload.input ?? {});
  if (!parsed.success) {
    return {
      status: 400,
      body: { ok: false, code: "VALIDATION_ERROR", error: "输入校验失败", issues: parsed.error.issues },
    };
  }

  if (CONFIRMATION_REQUIRED.includes(tool.permission) && !payload.confirm) {
    let preview: ToolPreview | undefined;
    try {
      preview = await buildToolPreview(app, name, parsed.data);
    } catch (error) {
      return { status: 400, body: { ok: false, code: "PREVIEW_ERROR", error: String(error) } };
    }
    return {
      status: 200,
      body: { needsConfirmation: true, tool: name, permission: tool.permission, preview },
    };
  }

  const result = await app.registry.run(name, parsed.data, {
    workspaceRoot: app.workspaceRoot,
    allowedPermissions: ALL_PERMISSIONS,
  });
  return { status: result.ok ? 200 : 400, body: result };
}
