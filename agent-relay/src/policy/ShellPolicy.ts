import {
  checkCommandRisk,
  type RiskLevel,
  type RiskVerdict,
} from "../tools/risk.js";

export { checkCommandRisk, type RiskLevel, type RiskVerdict };

export type ShellRiskTier = "low" | "medium" | "high";

/** 统一 shell 风险分级（供 shell_run / 后台任务共用）。 */
export function classifyShellCommand(command: string): {
  tier: ShellRiskTier;
  verdict: RiskVerdict;
  blocked: boolean;
} {
  const verdict = checkCommandRisk(command);
  const tier: ShellRiskTier =
    verdict.level === "dangerous" ? "high" : verdict.level === "caution" ? "medium" : "low";
  return { tier, verdict, blocked: tier === "high" };
}

export function assertShellAllowed(command: string): RiskVerdict {
  const { blocked, verdict } = classifyShellCommand(command);
  if (blocked) {
    throw new Error(`高风险命令被拒绝：${verdict.reason}`);
  }
  return verdict;
}

/** 后台任务用 legacy 文案兼容。 */
export function assertBackgroundCommandAllowed(command: string): RiskVerdict {
  const { blocked, verdict } = classifyShellCommand(command);
  if (blocked) {
    throw new Error(`危险命令被拦截：${verdict.reason}`);
  }
  return verdict;
}
