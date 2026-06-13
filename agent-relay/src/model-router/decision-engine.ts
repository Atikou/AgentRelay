import { randomUUID } from "node:crypto";

import type { ModelRegistry } from "./model-registry.js";
import { RouterModelEvaluator } from "./router-model-evaluator.js";
import {
  RouterError,
  type RouterDecision,
  type RouterInput,
  type RuleRouteResult,
} from "./types.js";

export class DecisionEngine {
  private readonly evaluator = new RouterModelEvaluator();

  constructor(private readonly registry: ModelRegistry) {}

  decide(rule: RuleRouteResult, input: RouterInput): RouterDecision {
    // V3 RouterModelEvaluator will plug in before this point only when rules are uncertain.
    const now = new Date().toISOString();
    const base = {
      id: randomUUID(),
      sessionId: input.sessionId,
      projectId: input.projectId,
      taskType: rule.taskType,
      selectedLevel: rule.requiredLevel,
      risk: rule.risk,
      reason: rule.reason,
      requireUserConfirmation: rule.requireUserConfirmation ?? false,
      createdAt: now,
      candidates: [] as string[],
    };

    if (input.forceModelId) {
      const forced = this.registry.get(input.forceModelId);
      if (!forced?.enabled) {
        throw new RouterError("NO_AVAILABLE_MODEL", `未找到指定模型：${input.forceModelId}`);
      }
      return {
        ...base,
        source: "manual_override",
        executionStrategy: "single_model",
        selectedModelId: forced.id,
        candidates: [forced.id],
        reason: `手动指定模型 ${forced.id}`,
      };
    }

    let strategy = rule.preferredStrategy ?? "single_model";
    if (
      strategy !== "rule_only" &&
      (input.forceSingleModel || input.allowCollaboration === false || input.qualityMode === "fast")
    ) {
      strategy = "single_model";
    } else if (
      strategy === "local_draft_remote_review" &&
      !rule.preferCollaboration &&
      input.qualityMode !== "deep"
    ) {
      strategy = "single_model";
    }

    if (strategy === "rule_only") {
      return {
        ...base,
        source: "rule",
        executionStrategy: "rule_only",
        candidates: [],
        reason: `${base.reason}；不调用模型`,
      };
    }

    if (strategy === "single_model") {
      const primary = this.registry.findPrimaryCandidates(rule, input.localOnly);
      if (primary.length === 0) {
        throw new RouterError("NO_AVAILABLE_MODEL", "没有可用模型满足当前任务要求");
      }
      const evaluation = this.evaluator.evaluate({
        routerInput: input,
        rule,
        candidates: primary,
      });
      let pick = primary[0]!;
      let source: RouterDecision["source"] = "rule";
      let reason = base.reason;
      if (evaluation.shouldOverrideRule && evaluation.recommendedModelId) {
        const override = primary.find((p) => p.id === evaluation.recommendedModelId);
        if (override) {
          pick = override;
          source = "evaluator";
          reason = `${base.reason}；V3 评估：${evaluation.reasons.join("，")}`;
        }
      }
      return {
        ...base,
        source,
        executionStrategy: "single_model",
        selectedModelId: pick.id,
        candidates: primary.map((p) => p.id),
        reason,
      };
    }

    return this.decideCollaboration(rule, input, base);
  }

  private decideCollaboration(
    rule: RuleRouteResult,
    input: RouterInput,
    base: Omit<RouterDecision, "source" | "executionStrategy" | "candidates"> & { candidates: string[] },
  ): RouterDecision {
    const drafts = this.registry.findDraftCandidates(
      rule,
      input.localOnly,
      input.contextTokenEstimate,
    );
    const reviews = this.registry.findReviewCandidates(rule, input.localOnly);

    if (reviews.length === 0) {
      if (rule.risk === "high") {
        throw new RouterError(
          "NO_REVIEW_MODEL_AVAILABLE",
          "高风险协作任务无可用审查模型，不允许静默降级",
        );
      }
      const primary = this.registry.findPrimaryCandidates(rule, input.localOnly);
      if (primary.length === 0) {
        throw new RouterError("NO_AVAILABLE_MODEL", "没有可用模型满足当前任务要求");
      }
      const strong = primary.find((p) => p.defaultLevel >= 3) ?? primary[0]!;
      return {
        ...base,
        source: "fallback",
        executionStrategy: "single_model",
        selectedModelId: strong.id,
        candidates: primary.map((p) => p.id),
        fallbackNote: "无审查模型，降级为 single_model",
        reason: `${base.reason}；无 review 模型`,
      };
    }

    const draft = drafts[0];
    const review = reviews[0]!;
    const allCandidates = [...new Set([...(draft ? [draft.id] : []), ...reviews.map((r) => r.id)])];

    if (!draft) {
      if (rule.risk === "low") {
        return {
          ...base,
          source: "fallback",
          executionStrategy: "single_model",
          selectedModelId: review.id,
          candidates: allCandidates,
          fallbackNote: "无草稿模型，直接使用审查模型",
        };
      }
      return {
        ...base,
        source: "fallback",
        executionStrategy: "single_model",
        selectedModelId: review.id,
        candidates: allCandidates,
        fallbackNote: "无草稿模型，中高风险改用强单模型",
      };
    }

    return {
      ...base,
      source: "rule",
      executionStrategy: "local_draft_remote_review",
      draftModelId: draft.id,
      reviewModelId: review.id,
      finalModelId: review.id,
      candidates: allCandidates,
    };
  }
}
