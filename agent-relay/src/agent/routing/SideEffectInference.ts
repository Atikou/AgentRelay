import type { SideEffectKind } from "../completion/TaskCompletionContract.js";
import { inferRequiredSideEffectsFromGoal } from "../completion/TaskCompletionContract.js";
import type { MessageContinuationSignals } from "./MessageSignalExtractor.js";

/**
 * 从 goal + 弱信号推断所需副作用。
 * 不做 intent/workflow 映射，仅输出 read/write/shell 需求供边界与裁决层使用。
 */
export function inferRequiredSideEffectsFromMessage(
  goal: string,
  signals?: Pick<
    MessageContinuationSignals,
    | "referencesProjectScope"
    | "expressesOutcomeDissatisfaction"
    | "requestsOutcomeChange"
    | "explicitReadonlyRequest"
  >,
): SideEffectKind[] {
  const fromGoal = inferRequiredSideEffectsFromGoal(goal);
  if (fromGoal.length > 0) return fromGoal;

  if (signals?.explicitReadonlyRequest) return [];

  if (
    signals?.referencesProjectScope &&
    (signals.expressesOutcomeDissatisfaction || signals.requestsOutcomeChange)
  ) {
    return ["write"];
  }

  return [];
}
