import { z } from "zod";

export const MIN_INTERVAL_MS = 1000;
export const MIN_DEBOUNCE_MS = 100;

export const TriggerStatusSchema = z.enum(["active", "paused", "cancelled", "completed"]);
export type TriggerStatus = z.infer<typeof TriggerStatusSchema>;

export const TriggerKindSchema = z.enum(["once", "interval", "cron", "event"]);
export type TriggerKind = z.infer<typeof TriggerKindSchema>;

export const MissPolicySchema = z.enum(["skip", "run_once"]);
export type MissPolicy = z.infer<typeof MissPolicySchema>;

export const SchedulerEventTypeSchema = z.enum([
  "background_completed",
  "file_changed",
  "git_changed",
]);
export type SchedulerEventType = z.infer<typeof SchedulerEventTypeSchema>;

export const CronMissPolicySchema = z.enum(["skip", "run_once"]);
export type CronMissPolicy = z.infer<typeof CronMissPolicySchema>;

export const EventFilterSchema = z.object({
  status: z.enum(["running", "completed", "failed", "cancelled"]).optional(),
  watchPath: z.string().optional(),
  pattern: z.string().optional(),
  debounceMs: z.number().int().min(MIN_DEBOUNCE_MS).optional(),
  /** git_changed：仅工作区脏时触发。 */
  dirtyOnly: z.boolean().optional(),
  /** git_changed：分支名过滤（可选）。 */
  branch: z.string().optional(),
  /** background_completed：stdout/stderr 输出须匹配（子串或正则）。 */
  outputPattern: z.string().optional(),
  outputRegex: z.boolean().optional(),
  outputStream: z.enum(["stdout", "stderr", "both"]).optional(),
  outputIgnoreCase: z.boolean().optional(),
});

export const TriggerRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: TriggerKindSchema,
  status: TriggerStatusSchema,
  /** 触发后写入通知队列的任务描述（不直接执行工具）。 */
  goal: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastFiredAt: z.string().optional(),
  fireCount: z.number().int().nonnegative(),
  at: z.string().optional(),
  intervalMs: z.number().int().min(MIN_INTERVAL_MS).optional(),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  eventType: SchedulerEventTypeSchema.optional(),
  eventFilter: EventFilterSchema.optional(),
  missPolicy: MissPolicySchema.optional(),
  cronMissPolicy: CronMissPolicySchema.optional(),
});
export type TriggerRecord = z.infer<typeof TriggerRecordSchema>;

export const CreateTriggerInputSchema = z
  .object({
    name: z.string().min(1),
    kind: TriggerKindSchema,
    goal: z.string().min(1),
    at: z.string().optional(),
    intervalMs: z.number().int().min(MIN_INTERVAL_MS).optional(),
    cron: z.string().optional(),
    timezone: z.string().optional(),
    eventType: SchedulerEventTypeSchema.optional(),
    eventFilter: EventFilterSchema.optional(),
    missPolicy: MissPolicySchema.optional(),
    cronMissPolicy: CronMissPolicySchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.kind === "once" && !val.at) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "once 触发器需要 at（ISO 时间）" });
    }
    if (val.kind === "interval" && !val.intervalMs) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "interval 触发器需要 intervalMs" });
    }
    if (val.kind === "cron" && !val.cron) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cron 触发器需要 cron 表达式" });
    }
    if (val.kind === "event" && !val.eventType) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "event 触发器需要 eventType" });
    }
  });
export type CreateTriggerInput = z.infer<typeof CreateTriggerInputSchema>;

export interface TriggerJournalUpsert {
  op: "upsert";
  time: string;
  trigger: TriggerRecord;
}

export interface TriggerJournalDelete {
  op: "delete";
  time: string;
  id: string;
}

export type TriggerJournalLine = TriggerJournalUpsert | TriggerJournalDelete;
