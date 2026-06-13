import type {
  ExecutionStrategy,
  ModelProfile,
  RouterInput,
  RuleRouteResult,
} from "./types.js";

export interface RouterModelEvaluation {
  source: "heuristic_v3" | "stub";
  shouldOverrideRule: boolean;
  recommendedStrategy: ExecutionStrategy;
  recommendedModelId?: string;
  confidence: number;
  reasons: string[];
  warnings: string[];
}

export interface RouterModelEvaluatorInput {
  routerInput: RouterInput;
  rule: RuleRouteResult;
  candidates: ModelProfile[];
}

const UNCERTAIN_TASK_TYPES = new Set<RuleRouteResult["taskType"]>([
  "unknown",
  "technical_qa",
  "simple_qa",
]);

/**
 * V3 运行时：规则不确定时在候选模型中做启发式自评（不调用额外模型）。
 * 仅在 `shouldOverrideRule=true` 时由 DecisionEngine 调整选型。
 */
export class RouterModelEvaluator {
  evaluate(input: RouterModelEvaluatorInput): RouterModelEvaluation {
    const recommendedStrategy = input.rule.preferredStrategy ?? "single_model";
    const warnings =
      input.candidates.length === 0 ? ["no_candidate_profiles_provided"] : [];

    const uncertain =
      UNCERTAIN_TASK_TYPES.has(input.rule.taskType) ||
      (input.routerInput.qualityMode === "deep" &&
        input.rule.taskType !== "high_risk_action" &&
        input.candidates.length > 1);

    if (uncertain && input.candidates.length > 0) {
      const sorted = [...input.candidates].sort((a, b) => {
        if (b.defaultLevel !== a.defaultLevel) return b.defaultLevel - a.defaultLevel;
        const costOrder = { free: 0, low: 1, medium: 2, high: 3 } as const;
        return costOrder[a.relativeCost] - costOrder[b.relativeCost];
      });
      const pick = sorted[0]!;
      return {
        source: "heuristic_v3",
        shouldOverrideRule: true,
        recommendedStrategy: "single_model",
        recommendedModelId: pick.id,
        confidence: input.rule.taskType === "unknown" ? 0.55 : 0.45,
        reasons: [
          `taskType=${input.rule.taskType}`,
          `qualityMode=${input.routerInput.qualityMode ?? "balanced"}`,
          "prefer_strongest_affordable_candidate",
        ],
        warnings,
      };
    }

    return {
      source: "stub",
      shouldOverrideRule: false,
      recommendedStrategy,
      recommendedModelId: input.candidates[0]?.id,
      confidence: 0,
      reasons: ["rule_confident_no_override"],
      warnings,
    };
  }
}
