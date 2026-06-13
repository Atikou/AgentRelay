import { z } from "zod";

export const OutputMatchRuleSchema = z.object({
  name: z.string().min(1),
  pattern: z.string().min(1),
  regex: z.boolean().optional(),
  ignoreCase: z.boolean().optional(),
  stream: z.enum(["stdout", "stderr", "both"]).optional(),
  /** 进程仍在输出时命中即触发（适合 ready 日志）；默认仅进程结束时评估。 */
  fireOnStream: z.boolean().optional(),
});

export type OutputMatchRule = z.infer<typeof OutputMatchRuleSchema>;

export const BackgroundTriggerOnMatchSchema = z.object({
  goal: z.string().min(1),
  mode: z.enum(["any", "all"]).optional(),
  requireSuccess: z.boolean().optional(),
});

export type BackgroundTriggerOnMatch = z.infer<typeof BackgroundTriggerOnMatchSchema>;

export interface OutputMatchResult {
  name: string;
  matched: boolean;
  stream?: "stdout" | "stderr" | "both";
  snippet?: string;
  /** 流式命中时间（fireOnStream） */
  firedAt?: string;
}

/** 常用匹配预设（可在 API 中引用或文档说明）。 */
export const OUTPUT_MATCH_PRESETS = {
  npmError: {
    name: "npm_error",
    pattern: "npm ERR!",
    stream: "stderr" as const,
  },
  testPassed: {
    name: "test_passed",
    pattern: "Tests?:\\s+\\d+\\s+passed|passed,\\s+\\d+\\s+failed",
    regex: true,
    ignoreCase: true,
    stream: "stdout" as const,
  },
  serverReady: {
    name: "server_ready",
    pattern: "listening on|ready on|Server running",
    regex: true,
    ignoreCase: true,
    stream: "stdout" as const,
    fireOnStream: true,
  },
} satisfies Record<string, OutputMatchRule>;
