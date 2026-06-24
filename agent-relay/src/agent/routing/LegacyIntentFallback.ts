import { defaultIntentRouter, type IntentRouteInput } from "../IntentRouter.js";
import type { IntentDecision } from "./IntentDecision.js";

/** 旧 IntentRouter 的 fallback 包装；不再作为主决策器。 */
export function resolveLegacyIntentFallback(input: IntentRouteInput): IntentDecision {
  const route = defaultIntentRouter.route(input);
  return {
    mode: route.mode,
    modeSource: route.modeSource,
    intent: route.intent,
    workflowType: route.workflowType,
    workflowPlan: route.workflowPlan,
    isContinuation: false,
    isNewTask: false,
    needsWrite: route.intent === "edit" || route.intent === "generate_file" || route.intent === "refactor",
    needsRunCommand: route.intent === "run" || route.intent === "verify",
    confidence: 0.55,
    reason: "legacy_intent_router_fallback",
    source: "legacy_fallback",
  };
}
