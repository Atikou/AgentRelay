import { promises as fs } from "node:fs";
import path from "node:path";

import type { DatabaseManager } from "./DatabaseManager.js";
import type {
  ProjectFileRecord,
  ProjectIndexStats,
  ProjectIndexSyncResult,
  ProjectSymbolRecord,
} from "./projectIndexTypes.js";

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export class ProjectIndex {
  constructor(private readonly db: DatabaseManager) {}

  getStats(projectId: string, workspaceRoot: string): ProjectIndexStats {
    const normalizedRoot = normalizeRoot(workspaceRoot);
    const fileRow = this.db.connection
      .prepare(
        `SELECT COUNT(*) AS count, MAX(indexed_at) AS last_indexed_at
         FROM project_files WHERE project_id=? AND workspace_root=?`,
      )
      .get(projectId, normalizedRoot) as { count: number; last_indexed_at?: string };
    const symbolRow = this.db.connection
      .prepare(
        `SELECT COUNT(*) AS count FROM project_symbols WHERE project_id=? AND workspace_root=?`,
      )
      .get(projectId, normalizedRoot) as { count: number };
    return {
      projectId,
      workspaceRoot: normalizedRoot,
      fileCount: fileRow.count,
      symbolCount: symbolRow.count,
      lastIndexedAt: fileRow.last_indexed_at,
    };
  }

  hasUsableIndex(projectId: string, workspaceRoot: string, minFiles = 8): boolean {
    return this.getStats(projectId, workspaceRoot).fileCount >= minFiles;
  }

  listFiles(projectId: string, workspaceRoot: string): ProjectFileRecord[] {
    const normalizedRoot = normalizeRoot(workspaceRoot);
    const rows = this.db.connection
      .prepare(
        `SELECT path, file_name, extension, size_bytes, modified_at, mtime_ms, content_hash,
                language, tags_json, summary
         FROM project_files
         WHERE project_id=? AND workspace_root=?
         ORDER BY path`,
      )
      .all(projectId, normalizedRoot) as Array<{
      path: string;
      file_name: string;
      extension: string;
      size_bytes: number;
      modified_at: string;
      mtime_ms: number;
      content_hash: string;
      language: string;
      tags_json: string;
      summary: string | null;
    }>;
    return rows.map((row) => ({
      path: row.path,
      fileName: row.file_name,
      extension: row.extension,
      sizeBytes: row.size_bytes,
      modifiedAt: row.modified_at,
      mtimeMs: row.mtime_ms,
      contentHash: row.content_hash,
      language: row.language,
      tags: parseTags(row.tags_json),
      summary: row.summary ?? undefined,
    }));
  }

  searchSymbols(
    projectId: string,
    workspaceRoot: string,
    names: string[],
  ): ProjectSymbolRecord[] {
    const normalizedRoot = normalizeRoot(workspaceRoot);
    const lowered = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    if (!lowered.length) return [];
    const hits: ProjectSymbolRecord[] = [];
    const stmt = this.db.connection.prepare(
      `SELECT file_path, symbol, kind, line
       FROM project_symbols
       WHERE project_id=? AND workspace_root=? AND lower(symbol)=?`,
    );
    for (const name of lowered) {
      const rows = stmt.all(projectId, normalizedRoot, name.toLowerCase()) as Array<{
        file_path: string;
        symbol: string;
        kind: string;
        line: number;
      }>;
      for (const row of rows) {
        hits.push({
          filePath: row.file_path,
          symbol: row.symbol,
          kind: row.kind,
          line: row.line,
        });
      }
    }
    return hits;
  }

  async syncFiles(input: {
    projectId: string;
    workspaceRoot: string;
    files: ProjectFileRecord[];
    extractSymbols?: boolean;
    summaries?: Map<string, string>;
  }): Promise<ProjectIndexSyncResult> {
    const normalizedRoot = normalizeRoot(input.workspaceRoot);
    const indexedAt = new Date().toISOString();
    const extractSymbols = input.extractSymbols ?? true;
    const incomingPaths = new Set(input.files.map((f) => f.path));

    const existingRows = this.db.connection
      .prepare(
        `SELECT path, content_hash FROM project_files WHERE project_id=? AND workspace_root=?`,
      )
      .all(input.projectId, normalizedRoot) as Array<{ path: string; content_hash: string }>;
    const existingHashes = new Map(existingRows.map((row) => [row.path, row.content_hash]));

    const upsertFile = this.db.connection.prepare(
      `INSERT INTO project_files
       (project_id, workspace_root, path, file_name, extension, size_bytes, modified_at, mtime_ms,
        content_hash, language, tags_json, summary, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, workspace_root, path) DO UPDATE SET
         file_name=excluded.file_name,
         extension=excluded.extension,
         size_bytes=excluded.size_bytes,
         modified_at=excluded.modified_at,
         mtime_ms=excluded.mtime_ms,
         content_hash=excluded.content_hash,
         language=excluded.language,
         tags_json=excluded.tags_json,
         summary=excluded.summary,
         indexed_at=excluded.indexed_at`,
    );
    const deleteSymbols = this.db.connection.prepare(
      `DELETE FROM project_symbols WHERE project_id=? AND workspace_root=? AND file_path=?`,
    );
    const insertSymbol = this.db.connection.prepare(
      `INSERT INTO project_symbols
       (project_id, workspace_root, file_path, symbol, kind, line, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, workspace_root, file_path, symbol) DO UPDATE SET
         kind=excluded.kind,
         line=excluded.line,
         indexed_at=excluded.indexed_at`,
    );

    let upserted = 0;
    let skipped = 0;
    let symbolsUpdated = 0;

    for (const file of input.files) {
      const priorHash = existingHashes.get(file.path);
      const hashChanged = priorHash !== file.contentHash;
      if (!hashChanged && priorHash) {
        skipped += 1;
        continue;
      }

      upsertFile.run(
        input.projectId,
        normalizedRoot,
        file.path,
        file.fileName,
        file.extension,
        file.sizeBytes,
        file.modifiedAt,
        file.mtimeMs,
        file.contentHash,
        file.language,
        JSON.stringify(file.tags),
        input.summaries?.get(file.path) ?? file.summary ?? null,
        indexedAt,
      );
      upserted += 1;

      if (!extractSymbols || !hashChanged || !CODE_EXTENSIONS.has(file.extension)) continue;
      const symbols = await extractSymbolsForFile(normalizedRoot, file.path);
      deleteSymbols.run(input.projectId, normalizedRoot, file.path);
      for (const symbol of symbols) {
        insertSymbol.run(
          input.projectId,
          normalizedRoot,
          file.path,
          symbol.symbol,
          symbol.kind,
          symbol.line,
          indexedAt,
        );
      }
      symbolsUpdated += symbols.length;
    }

    let removed = 0;
    for (const row of existingRows) {
      if (incomingPaths.has(row.path)) continue;
      this.db.connection
        .prepare(`DELETE FROM project_files WHERE project_id=? AND workspace_root=? AND path=?`)
        .run(input.projectId, normalizedRoot, row.path);
      deleteSymbols.run(input.projectId, normalizedRoot, row.path);
      removed += 1;
    }

    return { upserted, removed, symbolsUpdated, skipped };
  }
}

export function projectFileToScanMeta(file: ProjectFileRecord): {
  path: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
  modifiedAt: string;
  language: string;
  symbols: string[];
  imports: string[];
  exports: string[];
  tags: string[];
  hash: string;
} {
  return {
    path: file.path,
    fileName: file.fileName,
    extension: file.extension,
    sizeBytes: file.sizeBytes,
    modifiedAt: file.modifiedAt,
    language: file.language,
    symbols: [],
    imports: [],
    exports: [],
    tags: file.tags,
    hash: file.contentHash,
  };
}

export async function extractSymbolsForFile(
  workspaceRoot: string,
  relPath: string,
): Promise<ProjectSymbolRecord[]> {
  const abs = path.join(workspaceRoot, relPath);
  let content = "";
  try {
    const buf = await fs.readFile(abs);
    if (buf.includes(0)) return [];
    content = buf.toString("utf-8").slice(0, 120_000);
  } catch {
    return [];
  }
  return extractSymbolsFromContent(relPath, content);
}

export function extractSymbolsFromContent(
  filePath: string,
  content: string,
): ProjectSymbolRecord[] {
  const symbols: ProjectSymbolRecord[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const match = line.match(
      /^\s*(?:export\s+)?(class|function|interface|type|const|enum)\s+([A-Za-z0-9_]+)/,
    );
    if (!match) continue;
    symbols.push({
      filePath,
      symbol: match[2]!,
      kind: match[1]!,
      line: i + 1,
    });
    if (symbols.length >= 200) break;
  }
  return symbols;
}

function normalizeRoot(workspaceRoot: string): string {
  return path.resolve(workspaceRoot).replace(/\\/g, "/");
}

function parseTags(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
