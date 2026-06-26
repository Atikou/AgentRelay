import { defaultWorkflowRouter } from "../WorkflowRouter.js";
import type { IntentDecision } from "./IntentDecision.js";
import type { RoutingSnapshot } from "./RoutingSnapshot.js";

/** 为入口决策附加观测字段（边界、legacy hint、副作用需求）。 */
export function enrichIntentDecision(
  decision: IntentDecision,
  snapshot: Pick<RoutingSnapshot, "boundary" | "effectiveTaskContext">,
  legacyHint?: Pick<IntentDecision, "legacyIntentHint" | "legacyHintSources">,
): IntentDecision {
  const route = defaultWorkflowRouter.routeWorkflowType(decision.workflowType);
  const side = route?.sideEffectKind ?? "none";
  const boundary = snapshot.boundary;
  return {
    ...decision,
    boundaryBreakReason: boundary.breaksContinuation ? boundary.reason : undefined,
    effectiveTaskContextId: snapshot.effectiveTaskContext?.taskId,
    legacyIntentHint: legacyHint?.legacyIntentHint ?? decision.legacyIntentHint,
    legacyHintSources: legacyHint?.legacyHintSources ?? decision.legacyHintSources,
    needsWrite:
      decision.needsWrite ?? (side === "write" || side === "mixed"),
    needsRunCommand:
      decision.needsRunCommand ?? (side === "shell" || side === "mixed"),
  };
}
