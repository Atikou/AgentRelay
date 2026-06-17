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

export const ModelRouterProfileSchema = z.object({
  displayName: z.string().optional(),
  defaultLevel: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  enabled: z.boolean().optional(),
  supportsStreaming: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  supportsJsonMode: z.boolean().optional(),
  maxInputTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  relativeCost: z.enum(["free", "low", "medium", "high"]).optional(),
  avgLatencyMs: z.number().int().positive().optional(),
  allowedTaskTypes: z.array(z.string()).optional(),
  allowedRoles: z.array(z.enum(["primary", "draft", "review", "final"])).optional(),
  canDraft: z.boolean().optional(),
  canReview: z.boolean().optional(),
  canFinal: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
});
export type ModelRouterProfileConfig = z.infer<typeof ModelRouterProfileSchema>;

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
  /** 模型路由协作：等级、角色与能力（省略时按 location/模型名推断）。 */
  routerProfile: ModelRouterProfileSchema.optional(),
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

const ToolPermissionSchema = z.enum(["read", "write", "shell", "network", "dangerous"]);

export const SecurityConfigSchema = z.object({
  permissions: z
    .object({
      /** 项目级权限上限；未配置则允许全部内置权限。 */
      allowed: z.array(ToolPermissionSchema).optional(),
    })
    .optional(),
  shell: z
    .object({
      /** 正则列表：命中任一条时拒绝 shell_run / 后台命令。 */
      denyCommands: z.array(z.string().min(1)).default([]),
      /** 正则列表：配置后 shell_run / 后台命令必须命中任一条。 */
      allowCommands: z.array(z.string().min(1)).default([]),
    })
    .default({}),
  network: z
    .object({
      /** 正则列表：命中任一条时拒绝网络工具访问（对规范化 hostname 匹配）。 */
      denyDomains: z.array(z.string().min(1)).default([]),
      /** 正则列表：配置后网络工具目标必须命中任一条；未配置则不启用 allowlist。 */
      allowDomains: z.array(z.string().min(1)).default([]),
    })
    .default({}),
  budget: z
    .object({
      /** 单次 Agent Run 允许的最大估算费用（USD）；超出则中断循环。 */
      maxCostUsdPerRun: z.number().positive().optional(),
    })
    .optional(),
  subagent: z
    .object({
      /**
       * dispatch_subagent 允许的最大派生深度（主 Agent 为 0）。
       * 默认 1 = 仅主 Agent 可派生；不支持无限递归。
       */
      maxDispatchDepth: z.number().int().min(0).max(3).default(1),
      /** 批量 dispatch_subagent 最大并行子任务数（缓解本地模型并发排队）。 */
      maxBatchConcurrency: z.number().int().min(1).max(3).default(2),
    })
    .default({ maxDispatchDepth: 1, maxBatchConcurrency: 2 }),
});
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

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
  security: SecurityConfigSchema.optional(),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;
