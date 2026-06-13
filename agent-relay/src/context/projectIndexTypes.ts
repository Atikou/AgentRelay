export interface ProjectFileRecord {
  path: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
  modifiedAt: string;
  mtimeMs: number;
  contentHash: string;
  language: string;
  tags: string[];
  summary?: string;
}

export interface ProjectSymbolRecord {
  filePath: string;
  symbol: string;
  kind: string;
  line: number;
}

export interface ProjectIndexStats {
  projectId: string;
  workspaceRoot: string;
  fileCount: number;
  symbolCount: number;
  lastIndexedAt?: string;
}

export interface ProjectIndexSyncResult {
  upserted: number;
  removed: number;
  symbolsUpdated: number;
  skipped: number;
}
