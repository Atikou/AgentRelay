import { z } from "zod";

import type { BackgroundTaskRecord } from "./types.js";

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

function streamText(record: BackgroundTaskRecord, stream: OutputMatchRule["stream"]): string {
  if (stream === "stdout") return record.stdout;
  if (stream === "stderr") return record.stderr;
  return `${record.stdout}\n${record.stderr}`;
}

function testPattern(text: string, rule: OutputMatchRule): { matched: boolean; snippet?: string } {
  const flags = rule.ignoreCase ? "i" : "";
  let matched = false;
  if (rule.regex) {
    const re = new RegExp(rule.pattern, flags);
    const m = text.match(re);
    matched = m != null;
    return { matched, snippet: m?.[0]?.slice(0, 200) };
  }
  const hay = rule.ignoreCase ? text.toLowerCase() : text;
  const needle = rule.ignoreCase ? rule.pattern.toLowerCase() : rule.pattern;
  const idx = hay.indexOf(needle);
  matched = idx >= 0;
  return {
    matched,
    snippet: matched ? text.slice(idx, idx + Math.min(200, rule.pattern.length + 40)) : undefined,
  };
}

export function evaluateOutputRules(
  record: BackgroundTaskRecord,
  rules: OutputMatchRule[],
): OutputMatchResult[] {
  return rules.map((rule) => {
    const stream = rule.stream ?? "both";
    const { matched, snippet } = testPattern(streamText(record, stream), rule);
    return { name: rule.name, matched, stream, snippet };
  });
}

export function shouldTriggerOnMatch(
  record: BackgroundTaskRecord,
  rules: OutputMatchRule[],
  results: OutputMatchResult[],
  trigger: BackgroundTriggerOnMatch,
): boolean {
  if (rules.length === 0) return false;
  if (trigger.requireSuccess !== false && record.exitCode !== 0) return false;
  if (record.status !== "completed") return false;
  const mode = trigger.mode ?? "all";
  if (mode === "any") return results.some((r) => r.matched);
  return results.length > 0 && results.every((r) => r.matched);
}

export function matchRuleOnStream(
  record: BackgroundTaskRecord,
  rule: OutputMatchRule,
): OutputMatchResult | null {
  if (!rule.fireOnStream) return null;
  const stream = rule.stream ?? "both";
  const { matched, snippet } = testPattern(streamText(record, stream), rule);
  if (!matched) return null;
  return { name: rule.name, matched: true, stream, snippet, firedAt: new Date().toISOString() };
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
