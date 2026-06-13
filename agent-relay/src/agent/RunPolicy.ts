import { defaultRunPolicyManager } from "./RunPolicyManager.js";
import type { AgentRunMode, ResolveRunPolicyInput, RunPolicy } from "./RunPolicyTypes.js";
export type * from "./RunPolicyTypes.js";

export function resolveRunPolicy(input: ResolveRunPolicyInput = {}): RunPolicy {
  return defaultRunPolicyManager.resolve(input);
}

export function parseRunMode(mode: string | undefined): AgentRunMode | undefined {
  return defaultRunPolicyManager.parseMode(mode);
}

export { RunPolicyManager, defaultRunPolicyManager } from "./RunPolicyManager.js";
