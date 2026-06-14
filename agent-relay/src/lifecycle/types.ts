export type CleanupRisk = "low" | "medium" | "high";

export type CleanupActionType =
  | "delete_file"
  | "delete_directory"
  | "rewrite_file"
  | "compact_jsonl"
  | "delete_db_rows"
  | "vacuum_db";

export type StorageCategory =
  | "trace"
  | "timeline"
  | "sqlite_memory"
  | "sqlite_tools"
  | "cache"
  | "temp"
  | "reportCache"
  | "notifications"
  | "scheduler"
  | "routing"
  | "vector"
  | "lifecycle"
  | "other";

export interface LifecyclePolicy {
  version: number;
  mode: "local-first";
  cleanup: {
    autoEnabled: boolean;
    autoIntervalHours: number;
    requireDryRunBeforeApply: boolean;
    skipActiveRuns: boolean;
    lockTimeoutSeconds: number;
  };
  retentionDays: {
    runRawEventsSuccess: number;
    runRawEventsFailed: number;
    traceRawSuccess: number;
    traceRawFailed: number;
    toolArgs: number;
    toolOutput: number;
    routeDetails: number;
    readNotifications: number;
    completedSchedulerJournal: number;
    reportCache: number;
    searchCache: number;
    fileCache: number;
    temp: number;
    softDeletedRows: number;
  };
  quotas: {
    tempBytes: number;
    cacheBytes: number;
    reportCacheBytes: number;
    traceRawBytes: number;
    timelineRawBytes: number;
    maxToolOutputBytes: number;
  };
  trace: {
    rotationMaxBytes: number;
    rotationMaxAgeHours: number;
    compressOldSegments: boolean;
    compression: "gzip" | "zstd";
    keepIndex: boolean;
  };
  sqlite: {
    enableVacuum: boolean;
    vacuumAfterLargeCleanup: boolean;
    walCheckpointAfterCleanup: boolean;
  };
  privacy: {
    redactBeforeWrite: boolean;
    supportSessionPurge: boolean;
    purgeRewritesJsonlSegments: boolean;
    deleteActivityRunsOnSessionDelete: boolean;
  };
}

export interface StorageCategoryUsage {
  name: StorageCategory;
  bytes: number;
  files: number;
}

export interface LargestFileEntry {
  path: string;
  bytes: number;
  category: StorageCategory;
}

export interface StorageUsageReport {
  totalBytes: number;
  categories: StorageCategoryUsage[];
  largestFiles: LargestFileEntry[];
  generatedAt: number;
}

export interface CleanupAction {
  actionId: string;
  type: CleanupActionType;
  path: string;
  reason: string;
  bytes: number;
  risk: CleanupRisk;
  category: StorageCategory;
  canDelete: boolean;
  blockedReason?: string;
}

export interface CleanupPreviewRequest {
  scope?: "safe" | "all";
  include?: StorageCategory[];
  olderThanDays?: number | null;
  maxRisk?: CleanupRisk;
}

export interface CleanupPreviewSummary {
  candidateFiles: number;
  candidateDbRows: number;
  estimatedBytesToFree: number;
}

export interface CleanupPreviewReport {
  cleanupRunId: string;
  mode: "dry-run";
  startedAt: number;
  summary: CleanupPreviewSummary;
  actions: CleanupAction[];
  warnings: string[];
}

export interface CleanupApplyRequest {
  cleanupRunId: string;
  confirm: boolean;
}

export interface CleanupApplyResult {
  cleanupRunId: string;
  mode: "apply";
  startedAt: number;
  endedAt: number;
  applied: number;
  skipped: number;
  failed: number;
  bytesFreed: number;
  actions: Array<{
    actionId: string;
    type: CleanupActionType;
    target: string;
    status: "success" | "skipped" | "failed";
    bytesFreed: number;
    error?: string;
  }>;
}

export interface CleanupJournalEntry {
  cleanupRunId: string;
  actionId: string;
  type: CleanupActionType;
  target: string;
  status: "success" | "skipped" | "failed";
  bytesFreed: number;
  startedAt: number;
  endedAt: number;
  error?: string;
}

export interface TombstoneEntry {
  id: string;
  kind: "session_delete" | "session_purge" | "run_delete";
  sessionId?: string;
  runIds: string[];
  deletedAt: number;
  mode: "normal" | "purge";
}
