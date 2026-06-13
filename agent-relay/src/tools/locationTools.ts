import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { ProjectIndex } from "../context/ProjectIndex.js";
import { projectFileToScanMeta } from "../context/ProjectIndex.js";
import type { ProjectFileRecord } from "../context/projectIndexTypes.js";
import { DEFAULT_IGNORED_DIRS, DEFAULT_READ_MAX_BYTES } from "./constants.js";
import { resolveInsideWorkspace, shouldIgnoreDir } from "./pathSafe.js";
import type { Tool, ToolContext } from "./types.js";

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".css",
  ".html",
  ".yml",
  ".yaml",
  ".toml",
  ".txt",
]);

const CONFIG_FILE_NAMES = new Set([
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts",
  "eslint.config.js",
  "README.md",
  "AGENTS.md",
]);

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "当前",
  "项目",
  "系统",
  "这个",
  "一个",
  "需要",
  "实现",
  "完善",
  "问题",
]);

export interface LocateBudget {
  maxLocateSteps: number;
  maxSearchCalls: number;
  maxListCalls: number;
  maxReadForLocationCalls: number;
  maxCandidateFiles: number;
  maxPrimaryFiles: number;
}

export interface SearchPlan {
  goal: string;
  keywords: string[];
  possibleSymbols: string[];
  possiblePaths: string[];
  exclude: string[];
  taskType: "architecture_or_code_edit" | "debug" | "review" | "documentation" | "unknown";
}

export interface ProjectFileMeta {
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
  mtimeMs?: number;
}

interface LocatedFile {
  path: string;
  score: number;
  reason: string;
  matchTypes: Array<"path" | "symbol" | "keyword" | "memory" | "recent" | "importance">;
}

const DEFAULT_LOCATE_BUDGET: LocateBudget = {
  maxLocateSteps: 6,
  maxSearchCalls: 4,
  maxListCalls: 2,
  maxReadForLocationCalls: 2,
  maxCandidateFiles: 20,
  maxPrimaryFiles: 8,
};

const locateBudgetSchema = z.object({
  maxLocateSteps: z.number().int().positive(),
  maxSearchCalls: z.number().int().positive(),
  maxListCalls: z.number().int().positive(),
  maxReadForLocationCalls: z.number().int().min(0),
  maxCandidateFiles: z.number().int().positive(),
  maxPrimaryFiles: z.number().int().positive(),
});

const projectScanInputSchema = z.object({
  root: z.string().default("."),
  maxDepth: z.number().int().min(1).max(8).default(3),
  includePackageJson: z.boolean().default(true),
  includeTsConfig: z.boolean().default(true),
  exclude: z.array(z.string()).default([]),
});

const locateResumeContextSchema = z.object({
  visitedFiles: z.array(z.string()).default([]),
  visitedDirs: z.array(z.string()).default([]),
  candidateFiles: z.array(z.string()).default([]),
  primaryFiles: z.array(z.string()).default([]),
  searchPlan: z
    .object({
      goal: z.string(),
      keywords: z.array(z.string()).optional(),
      possibleSymbols: z.array(z.string()).optional(),
      possiblePaths: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
      taskType: z.string().optional(),
    })
    .partial()
    .optional(),
});

const locateRelevantFilesInputSchema = z.object({
  projectId: z.string().default("default"),
  goal: z.string().min(1),
  mode: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  possibleSymbols: z.array(z.string()).optional(),
  possiblePaths: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(100).default(20),
  locateBudget: locateBudgetSchema.partial().optional(),
  resumeContext: locateResumeContextSchema.optional(),
});

const contextPackInputSchema = z.object({
  files: z.array(z.string()).min(1),
  maxFiles: z.number().int().positive().max(20).default(8),
  maxTokens: z.number().int().positive().max(50_000).default(12_000),
  includeSummaries: z.boolean().default(true),
  includeImportantSections: z.boolean().default(true),
});

export function analyzeTaskQuery(goal: string, mode?: string): SearchPlan {
  const rawTokens = [...goal.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}|[\u4e00-\u9fa5]{2,}/g)].map((m) => m[0]);
  const camelSymbols = rawTokens.filter((t) => /[A-Z]/.test(t.slice(1)) || /^[A-Z][A-Za-z0-9_]+$/.test(t));
  const keywords = unique(
    rawTokens
      .map((t) => t.trim())
      .filter((t) => t.length >= 2)
      .filter((t) => !STOP_WORDS.has(t.toLowerCase()))
      .slice(0, 16),
  );
  const lower = goal.toLowerCase();
  const possiblePaths = new Set<string>();
  for (const k of keywords) {
    const normalized = k.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    if (normalized.includes("plan") || k.includes("计划")) possiblePaths.add("src/plan");
    if (normalized.includes("agent") || k.includes("智能体")) possiblePaths.add("src/agent");
    if (normalized.includes("context") || k.includes("上下文")) possiblePaths.add("src/context");
    if (normalized.includes("tool") || k.includes("工具")) possiblePaths.add("src/tools");
    if (normalized.includes("router") || k.includes("路由")) possiblePaths.add("src/model-router");
    if (normalized.includes("server") || k.includes("接口")) possiblePaths.add("src/server");
    if (normalized.includes("test") || k.includes("测试")) possiblePaths.add("tests");
    if (normalized.includes("doc") || k.includes("文档")) possiblePaths.add("docs");
  }
  if (possiblePaths.size === 0 && mode === "review") possiblePaths.add("src");
  const taskType = lower.includes("debug") || goal.includes("排错")
    ? "debug"
    : lower.includes("review") || goal.includes("审阅")
      ? "review"
      : lower.includes("doc") || goal.includes("文档")
        ? "documentation"
        : keywords.length > 0
          ? "architecture_or_code_edit"
          : "unknown";
  return {
    goal,
    keywords,
    possibleSymbols: unique([...camelSymbols, ...keywords.filter((k) => /^[A-Z]/.test(k))]).slice(0, 12),
    possiblePaths: [...possiblePaths].slice(0, 8),
    exclude: [...DEFAULT_IGNORED_DIRS],
    taskType,
  };
}

export const projectScanTool: Tool<
  typeof projectScanInputSchema,
  {
    projectType: string;
    sourceRoots: string[];
    configFiles: string[];
    scripts: Record<string, string>;
    importantDirs: string[];
    importantFiles: string[];
    scannedFiles: number;
    truncated: boolean;
    projectIndex?: {
      fileCount: number;
      symbolCount: number;
      upserted: number;
      removed: number;
      symbolsUpdated: number;
      skipped: number;
    };
  }
> = {
  name: "project_scan",
  description: "轻量扫描项目结构、配置文件、源码根和重要入口，避免用低层 list_files 逐级探索。",
  permission: "read",
  hasSideEffect: false,
  inputSchema: projectScanInputSchema,
  async execute(input, ctx) {
    const extraIgnore = new Set(input.exclude);
    const files = await collectProjectFiles(ctx, {
      root: input.root,
      maxDepth: input.maxDepth,
      limit: 800,
      extraIgnore,
      includeContent: false,
    });
    const paths = files.files.map((f) => f.path);
    const sourceRoots = unique(
      paths
        .map((p) => p.split("/")[0] ?? "")
        .filter((p): p is string => Boolean(p) && ["src", "tests", "test", "docs", "public", "config"].includes(p)),
    );
    const configFiles = paths.filter((p) => {
      const name = path.posix.basename(p);
      if (name === "package.json" && !input.includePackageJson) return false;
      if (name === "tsconfig.json" && !input.includeTsConfig) return false;
      return CONFIG_FILE_NAMES.has(name) || name.includes("config");
    });
    const importantFiles = rankImportantFiles(paths).slice(0, 24);
    const packageJson = input.includePackageJson ? await readJsonIfExists(ctx, "package.json") : undefined;
    const scripts = isRecord(packageJson) && isRecord(packageJson.scripts)
      ? packageJson.scripts as Record<string, string>
      : {};
    const baseResult = {
      projectType: detectProjectType(paths, packageJson),
      sourceRoots,
      configFiles,
      scripts,
      importantDirs: sourceRoots,
      importantFiles,
      scannedFiles: paths.length,
      truncated: files.truncated,
    };
    if (!ctx.projectIndex) return baseResult;
    const sync = await ctx.projectIndex.syncFiles({
      projectId: "default",
      workspaceRoot: ctx.workspaceRoot,
      files: files.files.map(fileMetaToProjectRecord),
      extractSymbols: true,
    });
    const stats = ctx.projectIndex.getStats("default", ctx.workspaceRoot);
    return {
      ...baseResult,
      projectIndex: {
        fileCount: stats.fileCount,
        symbolCount: stats.symbolCount,
        ...sync,
      },
    };
  },
};

export const locateRelevantFilesTool: Tool<
  typeof locateRelevantFilesInputSchema,
  {
    projectId: string;
    searchPlan: SearchPlan;
    primaryFiles: LocatedFile[];
    candidateFiles: LocatedFile[];
    unresolvedHints: string[];
    confidence: number;
    needsMoreSearch: boolean;
    stopReason: "enough_confidence" | "locate_budget_exhausted" | "no_candidates";
    locateStats: {
      usedLocateSteps: number;
      usedSearchCalls: number;
      usedListCalls: number;
      usedReadForLocationCalls: number;
      visitedFiles: string[];
      visitedDirs: string[];
    };
    indexSource: "project_index" | "filesystem";
    locationResume?: {
      mergedSearchPlan: boolean;
      skippedVisitedFiles: number;
      boostedCandidateFiles: number;
    };
  }
> = {
  name: "locate_relevant_files",
  description: "根据任务目标一次性生成搜索计划、合并候选并排序，返回 primaryFiles/candidateFiles。",
  permission: "read",
  hasSideEffect: false,
  timeoutMs: 20_000,
  inputSchema: locateRelevantFilesInputSchema,
  async execute(input, ctx) {
    const budget = { ...DEFAULT_LOCATE_BUDGET, ...input.locateBudget };
    const resumeCtx = input.resumeContext;
    const basePlan = analyzeTaskQuery(input.goal, input.mode);
    const resumedPlan = resumeCtx?.searchPlan;
    const searchPlan: SearchPlan = {
      ...basePlan,
      goal: resumedPlan?.goal ?? basePlan.goal,
      keywords: unique([
        ...(input.keywords ?? []),
        ...(resumedPlan?.keywords ?? []),
        ...basePlan.keywords,
      ]).slice(0, 20),
      possibleSymbols: unique([
        ...(input.possibleSymbols ?? []),
        ...(resumedPlan?.possibleSymbols ?? []),
        ...basePlan.possibleSymbols,
      ]).slice(0, 16),
      possiblePaths: unique([
        ...(input.possiblePaths ?? []),
        ...(resumedPlan?.possiblePaths ?? []),
        ...basePlan.possiblePaths,
      ]).slice(0, 12),
      exclude: unique([...basePlan.exclude, ...(resumedPlan?.exclude ?? [])]),
      taskType:
        isSearchPlanTaskType(resumedPlan?.taskType) ? resumedPlan.taskType : basePlan.taskType,
    };
    const visitedFiles = new Set(resumeCtx?.visitedFiles ?? []);
    const visitedDirs = new Set(resumeCtx?.visitedDirs ?? []);
    const resumeCandidates = new Set(resumeCtx?.candidateFiles ?? []);
    const resumePrimary = new Set(resumeCtx?.primaryFiles ?? []);
    const stats = {
      usedLocateSteps: 1,
      usedSearchCalls: 0,
      usedListCalls: 0,
      usedReadForLocationCalls: 0,
      visitedFiles: [] as string[],
      visitedDirs: [] as string[],
    };
    let files: { files: ProjectFileMeta[]; truncated: boolean };
    let indexSource: "project_index" | "filesystem" = "filesystem";
    if (ctx.projectIndex?.hasUsableIndex(input.projectId, ctx.workspaceRoot)) {
      const indexed = ctx.projectIndex.listFiles(input.projectId, ctx.workspaceRoot);
      files = { files: indexed.map(projectFileToScanMeta), truncated: false };
      indexSource = "project_index";
      stats.usedListCalls = 0;
    } else {
      files = await collectProjectFiles(ctx, {
        root: ".",
        maxDepth: 8,
        limit: 2000,
        extraIgnore: new Set(searchPlan.exclude),
        includeContent: false,
      });
      stats.usedListCalls = 1;
      if (ctx.projectIndex) {
        await ctx.projectIndex.syncFiles({
          projectId: input.projectId,
          workspaceRoot: ctx.workspaceRoot,
          files: files.files.map(fileMetaToProjectRecord),
          extractSymbols: true,
        });
      }
    }
    stats.visitedDirs = unique(files.files.map((f) => f.path.split("/").slice(0, -1).join("/") || ".")).slice(0, 80);
    const ranked = await rankCandidates(ctx, files.files, searchPlan, budget, stats, ctx.projectIndex, input.projectId, {
      visitedFiles,
      visitedDirs,
      resumeCandidates,
      resumePrimary,
    });
    const maxPrimary = Math.min(input.limit, budget.maxPrimaryFiles);
    const primaryFiles = ranked.filter((f) => f.score >= 0.7).slice(0, maxPrimary);
    const candidateFiles = ranked
      .filter((f) => !primaryFiles.some((p) => p.path === f.path))
      .slice(0, Math.min(input.limit, budget.maxCandidateFiles));
    const confidence = primaryFiles.length > 0
      ? Math.min(0.98, Math.max(...primaryFiles.map((f) => f.score)))
      : candidateFiles.length > 0
        ? Math.min(0.69, Math.max(...candidateFiles.map((f) => f.score)))
        : 0;
    const needsMoreSearch = confidence < 0.75 || primaryFiles.length < Math.min(3, budget.maxPrimaryFiles);
    const locateBudgetExhausted =
      stats.usedSearchCalls >= budget.maxSearchCalls ||
      stats.usedReadForLocationCalls >= budget.maxReadForLocationCalls ||
      files.truncated;
    const stopReason = primaryFiles.length === 0 && candidateFiles.length === 0
      ? "no_candidates"
      : needsMoreSearch && locateBudgetExhausted
        ? "locate_budget_exhausted"
        : "enough_confidence";
    return {
      projectId: input.projectId,
      searchPlan,
      primaryFiles,
      candidateFiles,
      unresolvedHints: buildUnresolvedHints(searchPlan, [...primaryFiles, ...candidateFiles]),
      confidence,
      needsMoreSearch,
      stopReason,
      locateStats: stats,
      indexSource,
      locationResume: resumeCtx
        ? {
            mergedSearchPlan: Boolean(resumedPlan),
            skippedVisitedFiles: [...visitedFiles].filter((p) =>
              stats.visitedFiles.includes(p) || ranked.every((r) => r.path !== p),
            ).length,
            boostedCandidateFiles: [...resumeCandidates].filter((p) =>
              ranked.some((r) => r.path === p),
            ).length,
          }
        : undefined,
    };
  },
};

export const contextPackTool: Tool<
  typeof contextPackInputSchema,
  {
    files: Array<{
      path: string;
      summary: string;
      content?: string;
      importantSections?: string[];
      truncated: boolean;
    }>;
    combinedSummary: string;
    tokenEstimate: number;
    skippedFiles: string[];
  }
> = {
  name: "context_pack",
  description: "一次性读取并摘要多个相关文件，减少连续 read_file 调用。",
  permission: "read",
  hasSideEffect: false,
  timeoutMs: 20_000,
  inputSchema: contextPackInputSchema,
  async execute(input, ctx) {
    const packed = [];
    const skippedFiles: string[] = [];
    let tokenEstimate = 0;
    const perFileChars = Math.max(1200, Math.floor((input.maxTokens * 4) / Math.min(input.maxFiles, input.files.length)));
    for (const file of unique(input.files).slice(0, input.maxFiles)) {
      const full = resolveInsideWorkspace(ctx.workspaceRoot, file);
      let content: string;
      try {
        const buf = await fs.readFile(full);
        if (buf.includes(0)) {
          skippedFiles.push(file);
          continue;
        }
        content = buf.toString("utf-8");
      } catch {
        skippedFiles.push(file);
        continue;
      }
      const clipped = content.slice(0, Math.min(perFileChars, DEFAULT_READ_MAX_BYTES));
      const truncated = clipped.length < content.length;
      const summary = input.includeSummaries ? summarizeFile(file, content) : "";
      const importantSections = input.includeImportantSections ? extractImportantSections(content) : undefined;
      const item = {
        path: file,
        summary,
        content: clipped,
        importantSections,
        truncated,
      };
      const itemTokens = estimateTokens(JSON.stringify(item));
      if (tokenEstimate + itemTokens > input.maxTokens && packed.length > 0) {
        skippedFiles.push(file);
        continue;
      }
      tokenEstimate += itemTokens;
      packed.push(item);
    }
    return {
      files: packed,
      combinedSummary: packed.map((f) => `- ${f.path}: ${f.summary}`).join("\n"),
      tokenEstimate,
      skippedFiles,
    };
  },
};

export async function collectProjectFiles(
  ctx: ToolContext,
  options: {
    root: string;
    maxDepth: number;
    limit: number;
    extraIgnore?: Set<string>;
    includeContent: boolean;
  },
): Promise<{ files: ProjectFileMeta[]; truncated: boolean }> {
  const rootAbs = resolveInsideWorkspace(ctx.workspaceRoot, options.root);
  const files: ProjectFileMeta[] = [];
  let truncated = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (files.length >= options.limit) {
      truncated = true;
      return;
    }
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= options.limit) {
        truncated = true;
        return;
      }
      if (d.isDirectory() && shouldIgnoreDir(d.name, options.extraIgnore)) continue;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (depth < options.maxDepth) await walk(abs, depth + 1);
        continue;
      }
      const ext = path.extname(d.name);
      if (!TEXT_EXTENSIONS.has(ext) && !CONFIG_FILE_NAMES.has(d.name)) continue;
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue;
      }
      if (stat.size > DEFAULT_READ_MAX_BYTES * 2) continue;
      const rel = path.relative(ctx.workspaceRoot, abs).replace(/\\/g, "/");
      files.push({
        path: rel,
        fileName: d.name,
        extension: ext,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        mtimeMs: stat.mtimeMs,
        language: languageFromExt(ext),
        symbols: [],
        imports: [],
        exports: [],
        tags: tagsForPath(rel),
        hash: createHash("sha1").update(`${rel}:${stat.size}:${stat.mtimeMs}`).digest("hex"),
      });
    }
  };
  await walk(rootAbs, 1);
  return { files, truncated };
}

async function rankCandidates(
  ctx: ToolContext,
  files: ProjectFileMeta[],
  plan: SearchPlan,
  budget: LocateBudget,
  stats: { usedSearchCalls: number; usedReadForLocationCalls: number; visitedFiles: string[] },
  projectIndex?: ProjectIndex,
  projectId = "default",
  resume?: {
    visitedFiles: Set<string>;
    visitedDirs: Set<string>;
    resumeCandidates: Set<string>;
    resumePrimary: Set<string>;
  },
): Promise<LocatedFile[]> {
  const ranked: LocatedFile[] = [];
  const loweredKeywords = plan.keywords.map((k) => k.toLowerCase());
  const symbolSet = new Set(plan.possibleSymbols.map((s) => s.toLowerCase()));
  if (projectIndex && plan.possibleSymbols.length) {
    const indexedHits = projectIndex.searchSymbols(projectId, ctx.workspaceRoot, plan.possibleSymbols);
    for (const hit of indexedHits) {
      symbolSet.add(hit.symbol.toLowerCase());
      const existing = files.find((f) => f.path === hit.filePath);
      if (!existing) {
        files.push({
          path: hit.filePath,
          fileName: path.posix.basename(hit.filePath),
          extension: path.posix.extname(hit.filePath),
          sizeBytes: 0,
          modifiedAt: new Date(0).toISOString(),
          language: languageFromExt(path.posix.extname(hit.filePath)),
          symbols: [hit.symbol],
          imports: [],
          exports: [],
          tags: tagsForPath(hit.filePath),
          hash: `symbol:${hit.symbol}`,
        });
      } else if (!existing.symbols.includes(hit.symbol)) {
        existing.symbols.push(hit.symbol);
      }
    }
  }
  const pathHints = plan.possiblePaths.map((p) => p.toLowerCase().replace(/\\/g, "/"));
  for (const file of files) {
    const p = file.path.toLowerCase();
    const name = file.fileName.toLowerCase();
    let score = 0;
    const matchTypes = new Set<LocatedFile["matchTypes"][number]>();
    const reasons: string[] = [];
    const alreadyVisited = resume?.visitedFiles.has(file.path) ?? false;
    if (resume?.resumePrimary.has(file.path)) {
      score += 0.4;
      matchTypes.add("memory");
      reasons.push("续跑 primary 候选保留");
    } else if (resume?.resumeCandidates.has(file.path)) {
      score += 0.25;
      matchTypes.add("memory");
      reasons.push("续跑 candidate 候选保留");
    }
    for (const hint of pathHints) {
      if (p.includes(hint)) {
        score += 0.35;
        matchTypes.add("path");
        reasons.push(`路径命中 ${hint}`);
      }
    }
    for (const keyword of loweredKeywords) {
      if (p.includes(keyword.toLowerCase()) || name.includes(keyword.toLowerCase())) {
        score += 0.22;
        matchTypes.add("keyword");
        reasons.push(`文件路径/名称命中 ${keyword}`);
      }
    }
    for (const symbol of file.symbols) {
      if (symbolSet.has(symbol.toLowerCase())) {
        score += 0.28;
        matchTypes.add("symbol");
        reasons.push(`索引符号命中 ${symbol}`);
      }
    }
    if (CONFIG_FILE_NAMES.has(file.fileName) || file.tags.includes("entry")) {
      score += 0.12;
      matchTypes.add("importance");
      reasons.push("重要配置或入口文件");
    }
    const allowContentRead =
      !alreadyVisited ||
      symbolSet.size > 0 ||
      resume?.resumePrimary.has(file.path) ||
      resume?.resumeCandidates.has(file.path);
    if (score > 0 || (allowContentRead && stats.usedReadForLocationCalls < budget.maxReadForLocationCalls)) {
      if (alreadyVisited && score > 0) {
        matchTypes.add("recent");
        reasons.push("续跑已访问（跳过重复读内容）");
      } else if (alreadyVisited) {
        continue;
      }
      const contentScore = allowContentRead && !alreadyVisited
        ? await scoreFileContent(ctx, file.path, loweredKeywords, symbolSet)
        : { score: 0, matchTypes: [] as LocatedFile["matchTypes"], reasons: [] as string[] };
      if (contentScore.score > 0) {
        stats.usedSearchCalls = Math.min(budget.maxSearchCalls, stats.usedSearchCalls + 1);
        stats.usedReadForLocationCalls += 1;
        stats.visitedFiles.push(file.path);
        score += contentScore.score;
        for (const t of contentScore.matchTypes) matchTypes.add(t);
        reasons.push(...contentScore.reasons);
      }
    }
    if (score > 0) {
      ranked.push({
        path: file.path,
        score: Number(Math.min(0.99, score).toFixed(2)),
        reason: unique(reasons).slice(0, 4).join("；"),
        matchTypes: [...matchTypes],
      });
    }
  }
  return ranked
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, budget.maxCandidateFiles);
}

async function scoreFileContent(
  ctx: ToolContext,
  rel: string,
  keywords: string[],
  symbols: Set<string>,
): Promise<{ score: number; matchTypes: LocatedFile["matchTypes"]; reasons: string[] }> {
  let content = "";
  try {
    const buf = await fs.readFile(resolveInsideWorkspace(ctx.workspaceRoot, rel));
    if (buf.includes(0)) return { score: 0, matchTypes: [], reasons: [] };
    content = buf.toString("utf-8").slice(0, 80_000);
  } catch {
    return { score: 0, matchTypes: [], reasons: [] };
  }
  const lower = content.toLowerCase();
  let score = 0;
  const matchTypes = new Set<LocatedFile["matchTypes"][number]>();
  const reasons: string[] = [];
  const foundKeywords = keywords.filter((k) => lower.includes(k.toLowerCase())).slice(0, 4);
  if (foundKeywords.length) {
    score += Math.min(0.32, foundKeywords.length * 0.08);
    matchTypes.add("keyword");
    reasons.push(`内容命中 ${foundKeywords.join(", ")}`);
  }
  const foundSymbols = [...symbols].filter((s) => lower.includes(s.toLowerCase())).slice(0, 4);
  if (foundSymbols.length) {
    score += Math.min(0.35, foundSymbols.length * 0.12);
    matchTypes.add("symbol");
    reasons.push(`符号命中 ${foundSymbols.join(", ")}`);
  }
  return { score, matchTypes: [...matchTypes], reasons };
}

function summarizeFile(file: string, content: string): string {
  const lines = content.split(/\r?\n/);
  const symbols = extractImportantSections(content).slice(0, 3).map((s) => s.split("\n")[0]?.trim()).filter(Boolean);
  return `${lines.length} 行，${estimateTokens(content)} tokens 估算${symbols.length ? `，关键定义：${symbols.join(" / ")}` : ""}`;
}

function extractImportantSections(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const sections: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s*(export\s+)?(class|function|interface|type|const|enum)\s+[A-Za-z0-9_]+/.test(line)) {
      sections.push(lines.slice(i, Math.min(lines.length, i + 8)).join("\n"));
    }
    if (sections.length >= 8) break;
  }
  return sections;
}

function buildUnresolvedHints(plan: SearchPlan, located: LocatedFile[]): string[] {
  const text = located.map((f) => `${f.path} ${f.reason}`).join("\n").toLowerCase();
  return [...plan.keywords, ...plan.possibleSymbols]
    .filter((h) => !text.includes(h.toLowerCase()))
    .slice(0, 8);
}

function rankImportantFiles(paths: string[]): string[] {
  return paths
    .map((p) => ({
      path: p,
      score: CONFIG_FILE_NAMES.has(path.posix.basename(p)) ? 2 : p.startsWith("src/") ? 1 : 0,
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .map((x) => x.path);
}

function detectProjectType(paths: string[], packageJson: unknown): string {
  if (paths.includes("package.json")) {
    const deps = {
      ...((isRecord(packageJson) && isRecord(packageJson.dependencies)) ? packageJson.dependencies : {}),
      ...((isRecord(packageJson) && isRecord(packageJson.devDependencies)) ? packageJson.devDependencies : {}),
    };
    if ("typescript" in deps || paths.includes("tsconfig.json")) return "typescript_node";
    return "node";
  }
  if (paths.some((p) => p.endsWith(".py"))) return "python";
  return "unknown";
}

async function readJsonIfExists(ctx: ToolContext, rel: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(resolveInsideWorkspace(ctx.workspaceRoot, rel), "utf-8"));
  } catch {
    return undefined;
  }
}

function tagsForPath(rel: string): string[] {
  const tags: string[] = [];
  if (rel.startsWith("src/")) tags.push("source");
  if (rel.startsWith("tests/") || rel.includes(".test.")) tags.push("test");
  if (rel.startsWith("docs/") || rel.endsWith(".md")) tags.push("doc");
  if (CONFIG_FILE_NAMES.has(path.posix.basename(rel))) tags.push("entry");
  return tags;
}

function languageFromExt(ext: string): string {
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "javascript";
  if (ext === ".md") return "markdown";
  if (ext === ".json") return "json";
  return ext.replace(/^\./, "") || "text";
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isSearchPlanTaskType(value: unknown): value is SearchPlan["taskType"] {
  return (
    value === "architecture_or_code_edit" ||
    value === "debug" ||
    value === "review" ||
    value === "documentation" ||
    value === "unknown"
  );
}

function fileMetaToProjectRecord(file: ProjectFileMeta): ProjectFileRecord {
  return {
    path: file.path,
    fileName: file.fileName,
    extension: file.extension,
    sizeBytes: file.sizeBytes,
    modifiedAt: file.modifiedAt,
    mtimeMs: file.mtimeMs ?? Date.parse(file.modifiedAt),
    contentHash: file.hash,
    language: file.language,
    tags: file.tags,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
