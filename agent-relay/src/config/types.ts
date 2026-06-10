import { z } from "zod";

export const ModelProviderSchema = z.enum(["openai-compatible", "ollama", "anthropic"]);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export const ModelLocationSchema = z.enum(["local", "remote"]);

export const RoutingStrategySchema = z.enum([
  "local-first",
  "cloud-first",
  "privacy-first",
  "quality-first",
]);
export type RoutingStrategy = z.infer<typeof RoutingStrategySchema>;

export const ModelClientConfigSchema = z.object({
  name: z.string().min(1),
  provider: ModelProviderSchema,
  location: ModelLocationSchema,
  baseUrl: z.string().url(),
  model: z.string().min(1),
  /** 直接写入的 key（建议仅本地占位使用）。 */
  apiKey: z.string().optional(),
  /** 从环境变量读取 key 的变量名（远程服务推荐）。 */
  apiKeyEnv: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  /** 仅 anthropic：API 版本头，默认 2023-06-01。 */
  apiVersion: z.string().optional(),
  /** 仅 anthropic：messages API 必填 max_tokens 的默认值。 */
  maxTokens: z.number().int().positive().optional(),
  /** 仅 ollama：是否启用 thinking 字段；默认 false，避免 content 为空。 */
  think: z.union([z.boolean(), z.enum(["low", "medium", "high"])]).optional(),
  /** 可选计价：每 1k 输入 token 的美元价格（用于成本统计）。 */
  pricePer1kInputUsd: z.number().nonnegative().optional(),
  /** 可选计价：每 1k 输出 token 的美元价格。 */
  pricePer1kOutputUsd: z.number().nonnegative().optional(),
});
export type ModelClientConfig = z.infer<typeof ModelClientConfigSchema>;

export const SchedulerConfigSchema = z.object({
  /** goal 子串匹配时通知 payload 不要求确认（无人值守白名单）。 */
  unattendedGoalPatterns: z.array(z.string()).default([]),
  gitPollIntervalMs: z.number().int().positive().default(5000),
  cronMissPolicy: z.enum(["skip", "run_once"]).default("skip"),
  /** 启动时注册 daily_summary cron（可选，如 `0 9 * * *`）。 */
  dailySummaryCron: z.string().optional(),
  dailySummaryGoal: z.string().optional(),
});
export type SchedulerConfig = z.infer<typeof SchedulerConfigSchema>;

export const AppConfigSchema = z.object({
  workspaceRoot: z.string().min(1),
  models: z.object({
    default: z.string().min(1),
    clients: z.array(ModelClientConfigSchema).min(1),
  }),
  routing: z.object({
    strategy: RoutingStrategySchema,
    fallback: z.boolean(),
  }),
  scheduler: SchedulerConfigSchema.optional(),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;
