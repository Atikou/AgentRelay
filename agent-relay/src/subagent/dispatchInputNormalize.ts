/** dispatch_subagent 入参预校验修复与超时策略（主 Agent 常见契约违背兜底）。 */

export const MIN_SUBAGENT_TIMEOUT_MS = 120_000;
export const DEFAULT_SUBAGENT_BATCH_CONCURRENCY = 2;
export const DEFAULT_SUBAGENT_TIMEOUT_CONFIG_MS = 180_000;

let configuredDefaultTimeoutMs = DEFAULT_SUBAGENT_TIMEOUT_CONFIG_MS;

export function setSubagentDefaultTimeoutMs(ms: number): void {
  configuredDefaultTimeoutMs = Math.max(MIN_SUBAGENT_TIMEOUT_MS, Math.floor(ms));
}

/**
 * 将主 Agent 传入的 timeoutMs 收敛到安全下限。
 * 批量任务不因并发而缩短单任务预算（每任务仍至少 MIN）。
 */
export function resolveSubagentTimeoutMs(requested?: number): number {
  const fallback = configuredDefaultTimeoutMs;
  if (requested == null || !Number.isFinite(requested)) {
    return Math.max(fallback, MIN_SUBAGENT_TIMEOUT_MS);
  }
  const n = Math.floor(requested);
  if (n <= 0) return Math.max(fallback, MIN_SUBAGENT_TIMEOUT_MS);
  return Math.max(n, MIN_SUBAGENT_TIMEOUT_MS);
}

const VALID_WRITE_FILE_PICK = new Set(["latest", "earliest", "arbitration"] as const);

const MODEL_POLICY_KEYS = new Set([
  "prefer",
  "allowRemoteEscalation",
  "requiredCapabilities",
  "minQuality",
]);

export function normalizeDispatchSubagentInput(rawInput: unknown): unknown {
  if (!isRecord(rawInput)) return rawInput;
  const out: Record<string, unknown> = { ...rawInput };

  if (Array.isArray(out.tasks)) {
    out.tasks = out.tasks.map((t) => normalizeDelegatedTaskInput(t));
  }

  out.writeFilePickStrategy = normalizeWriteFilePickStrategy(out.writeFilePickStrategy);

  if (out.timeoutMs != null) {
    out.timeoutMs = resolveSubagentTimeoutMs(Number(out.timeoutMs));
  }

  if (out.writeFilePickStrategy === undefined) {
    delete out.writeFilePickStrategy;
  }

  return out;
}

function normalizeDelegatedTaskInput(task: unknown): Record<string, unknown> {
  if (!isRecord(task)) return { goal: String(task) };
  const out: Record<string, unknown> = { ...task };
  out.modelPolicy = normalizeModelPolicy(out.modelPolicy);
  if (out.modelPolicy === undefined) delete out.modelPolicy;
  return out;
}

function normalizeModelPolicy(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    // 常见误用："default" / "auto"
    return {};
  }
  if (!isRecord(value)) return {};
  const fixed: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!MODEL_POLICY_KEYS.has(key)) continue;
    fixed[key] = v;
  }
  return Object.keys(fixed).length > 0 ? fixed : {};
}

function normalizeWriteFilePickStrategy(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "last" || normalized === "newest" || normalized === "recent") {
    return "latest";
  }
  if (normalized === "first" || normalized === "oldest") {
    return "earliest";
  }
  if (VALID_WRITE_FILE_PICK.has(normalized as (typeof VALID_WRITE_FILE_PICK extends Set<infer T> ? T : never))) {
    return normalized;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
