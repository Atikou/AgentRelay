import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { DatabaseManager } from "../context/DatabaseManager.js";
import { CleanupExecutor } from "./CleanupExecutor.js";
import { CleanupJournal } from "./CleanupJournal.js";
import { CleanupLock } from "./CleanupLock.js";
import { CleanupPlanner } from "./CleanupPlanner.js";
import { loadLifecyclePolicy, lifecycleDir } from "./policy.js";
import { StorageInventoryService } from "./StorageInventoryService.js";
import {
  cleanupSessionArtifacts,
  deleteRunArtifacts,
  type RunArtifactCleanupResult,
} from "./SessionArtifactCleaner.js";
import type { TraceCatalog } from "../trace/traceCatalog.js";
import { purgeSessionPrivacy, type SessionPurgeResult } from "./SessionPrivacyPurger.js";
import { runSqliteMaintenance } from "./sqliteMaintenance.js";
import type {
  CleanupApplyRequest,
  CleanupApplyResult,
  CleanupPreviewReport,
  CleanupPreviewRequest,
  LifecyclePolicy,
  StorageUsageReport,
} from "./types.js";

export type { SessionPurgeResult } from "./SessionPrivacyPurger.js";

export interface DataLifecycleServiceDeps {
  dataDir: string;
  workspaceRoot: string;
  traceFile: string;
  notificationFile: string;
  schedulerJournalFile: string;
  memoryDb: DatabaseManager;
  toolsDbPath?: string;
  tracesDir: string;
  traceCatalog: TraceCatalog;
  getActiveRunIds: () => string[];
}

interface StoredPreview {
  report: CleanupPreviewReport;
  expiresAt: number;
}

export class DataLifecycleService {
  private readonly policy: LifecyclePolicy;
  private readonly inventory: StorageInventoryService;
  private readonly journal: CleanupJournal;
  private readonly previews = new Map<string, StoredPreview>();

  constructor(private readonly deps: DataLifecycleServiceDeps) {
    this.policy = loadLifecyclePolicy(deps.dataDir);
    this.inventory = new StorageInventoryService({
      dataDir: deps.dataDir,
      workspaceRoot: deps.workspaceRoot,
      traceFile: deps.traceFile,
      notificationFile: deps.notificationFile,
      schedulerJournalFile: deps.schedulerJournalFile,
      memoryDbPath: deps.memoryDb.dbPath,
      toolsDbPath: deps.toolsDbPath,
    });
    this.journal = new CleanupJournal(deps.dataDir);
    this.loadPreviewsFromDisk();
  }

  getPolicy() {
    return this.policy;
  }

  getUsage(): StorageUsageReport {
    return this.inventory.scan();
  }

  /** 已执行清理批次的历史（最近优先），用于审计「实际删了什么」。 */
  listCleanupRuns(limit = 50) {
    return this.journal.listRecent(limit);
  }

  preview(request: CleanupPreviewRequest = {}): CleanupPreviewReport {
    const planner = new CleanupPlanner(
      {
        dataDir: this.deps.dataDir,
        workspaceRoot: this.deps.workspaceRoot,
        traceFile: this.deps.traceFile,
        tracesDir: this.deps.tracesDir,
        notificationFile: this.deps.notificationFile,
        schedulerJournalFile: this.deps.schedulerJournalFile,
        memoryDb: this.deps.memoryDb,
        getActiveRunIds: this.deps.getActiveRunIds,
      },
      this.policy,
    );
    const actions = planner.plan(request);
    const deletable = actions.filter((a) => a.canDelete);
    const report: CleanupPreviewReport = {
      cleanupRunId: `cleanup_${formatRunIdDate()}_${randomUUID().slice(0, 6)}`,
      mode: "dry-run",
      startedAt: Date.now(),
      summary: {
        candidateFiles: deletable.filter((a) => a.type === "delete_file" || a.type === "delete_directory").length,
        candidateDbRows: deletable
          .filter((a) => a.type === "delete_db_rows")
          .reduce((s, a) => s + Math.max(1, Math.round(a.bytes / 384)), 0),
        estimatedBytesToFree: deletable.reduce((s, a) => s + a.bytes, 0),
      },
      actions,
      warnings: actions.filter((a) => !a.canDelete).map((a) => `${a.path}: ${a.blockedReason ?? "blocked"}`),
    };
    this.storePreview(report);
    return report;
  }

  apply(request: CleanupApplyRequest): CleanupApplyResult | { error: string; status: number } {
    if (!request.confirm) {
      return { error: "apply 需要 confirm: true", status: 400 };
    }
    const stored = this.previews.get(request.cleanupRunId) ?? this.loadPreviewFromDisk(request.cleanupRunId);
    if (!stored) {
      return { error: `未找到清理预览：${request.cleanupRunId}，请先调用 preview`, status: 404 };
    }
    if (Date.now() > stored.expiresAt) {
      return { error: "清理预览已过期，请重新 preview", status: 410 };
    }

    const lock = new CleanupLock(this.deps.dataDir, this.policy.cleanup.lockTimeoutSeconds);
    if (!lock.acquire()) {
      return { error: "另一项清理任务正在执行，请稍后重试", status: 409 };
    }

    try {
      const executor = new CleanupExecutor(this.journal, this.policy, this.deps.memoryDb);
      const deletable = stored.report.actions.filter((a) => a.canDelete && a.risk === "low");
      const result = executor.apply(deletable, request.cleanupRunId, stored.report.startedAt);
      if (result.applied > 0) {
        runSqliteMaintenance(this.deps.memoryDb, this.deps.toolsDbPath, this.policy);
      }
      return result;
    } finally {
      lock.release();
      this.previews.delete(request.cleanupRunId);
      this.deletePreviewFile(request.cleanupRunId);
    }
  }

  /** 策略 `cleanup.autoEnabled` 为 true 时由服务端定时调用：preview safe + apply。 */
  runAutoSafeCleanup(): CleanupApplyResult | { autoSkipped: true; reason: string } {
    if (!this.policy.cleanup.autoEnabled) {
      return { autoSkipped: true, reason: "autoEnabled=false" };
    }
    const report = this.preview({ scope: "safe" });
    const deletable = report.actions.filter((a) => a.canDelete && a.risk === "low");
    if (deletable.length === 0) {
      return { autoSkipped: true, reason: "no_deletable_candidates" };
    }
    const result = this.apply({ cleanupRunId: report.cleanupRunId, confirm: true });
    if ("error" in result) {
      throw new Error(result.error);
    }
    return result;
  }

  onSessionDeleted(sessionId: string, runIds: string[]): { runIds: string[]; bytesFreed: number } {
    if (runIds.length === 0) {
      return { runIds: [], bytesFreed: 0 };
    }
    const result = cleanupSessionArtifacts({
      dataDir: this.deps.dataDir,
      workspaceRoot: this.deps.workspaceRoot,
      sessionId,
      runIds,
      deleteTimeline: this.policy.privacy.deleteActivityRunsOnSessionDelete,
    });
    return { runIds, bytesFreed: result.bytesFreed };
  }

  onRunDeleted(runId: string, sessionId?: string): RunArtifactCleanupResult {
    return deleteRunArtifacts({
      dataDir: this.deps.dataDir,
      workspaceRoot: this.deps.workspaceRoot,
      runId,
      sessionId,
      removeTimeline: this.policy.privacy.deleteActivityRunsOnSessionDelete,
    });
  }

  purgeSessionPrivacy(sessionId: string, runIds: string[]): SessionPurgeResult {
    if (!this.policy.privacy.supportSessionPurge) {
      throw new Error("policy.privacy.supportSessionPurge 未启用");
    }
    return purgeSessionPrivacy(
      {
        dataDir: this.deps.dataDir,
        workspaceRoot: this.deps.workspaceRoot,
        memoryDb: this.deps.memoryDb,
        toolsDbPath: this.deps.toolsDbPath,
        traceCatalog: this.deps.traceCatalog,
        notificationFile: this.deps.notificationFile,
        policy: this.policy,
      },
      sessionId,
      runIds,
    );
  }

  private storePreview(report: CleanupPreviewReport): void {
    const expiresAt = Date.now() + 60 * 60 * 1000;
    this.previews.set(report.cleanupRunId, { report, expiresAt });
    const dir = path.join(lifecycleDir(this.deps.dataDir), "previews");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `${report.cleanupRunId}.json`),
      JSON.stringify({ report, expiresAt }),
      "utf-8",
    );
  }

  private loadPreviewsFromDisk(): void {
    const dir = path.join(lifecycleDir(this.deps.dataDir), "previews");
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(readFileSync(path.join(dir, name), "utf-8")) as StoredPreview;
        if (Date.now() > raw.expiresAt) continue;
        this.previews.set(raw.report.cleanupRunId, raw);
      } catch {
        continue;
      }
    }
  }

  private loadPreviewFromDisk(cleanupRunId: string): StoredPreview | undefined {
    const file = path.join(lifecycleDir(this.deps.dataDir), "previews", `${cleanupRunId}.json`);
    if (!existsSync(file)) return undefined;
    try {
      const raw = JSON.parse(readFileSync(file, "utf-8")) as StoredPreview;
      if (Date.now() > raw.expiresAt) return undefined;
      this.previews.set(cleanupRunId, raw);
      return raw;
    } catch {
      return undefined;
    }
  }

  private deletePreviewFile(cleanupRunId: string): void {
    const file = path.join(lifecycleDir(this.deps.dataDir), "previews", `${cleanupRunId}.json`);
    if (existsSync(file)) {
      try {
        unlinkSync(file);
      } catch {
        // ignore
      }
    }
  }
}

function formatRunIdDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}
