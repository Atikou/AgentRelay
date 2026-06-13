import { randomUUID } from "node:crypto";

import type { ModelRegistry } from "./model-registry.js";
import { applyRoutingContext, type RoutingContext } from "./context-analyzer.js";
import { RouterModelEvaluator } from "./router-model-evaluator.js";
import type { RuntimeStatsFeedback } from "./runtime-stats-feedback.js";
import {
  RouterError,
  type ModelProfile,
  type RouterDecision,
  type RouterInput,
  type RuleRouteResult,
  type TaskType,
} from "./types.js";

export class DecisionEngine {
  private readonly evaluator = new RouterModelEvaluator();

  constructor(
    private readonly registry: ModelRegistry,
    private readonly runtimeFeedback?: RuntimeStatsFeedback,
  ) {}

  decide(rule: RuleRouteResult, input: RouterInput, routingContext?: RoutingContext): RouterDecision {
    const context = routingContext;
    let effectiveRule = context ? applyRoutingContext(rule, context) : rule;
    if (context?.suggestedLevelBump) {
      const probe = this.registry.findPrimaryCandidates(effectiveRule, input.localOnly);
      if (probe.length === 0) {
        effectiveRule = rule;
      }
    }
    const contextNote =
      context && context.signals.length > 0
        ? `；V8 上下文：${context.signals.join("，")}`
        : "";

    // V3 RouterModelEvaluator will plug in before this point only when rules are uncertain.
    const now = new Date().toISOString();
    const base = {
      id: randomUUID(),
      sessionId: input.sessionId,
      projectId: input.projectId,
      taskType: effectiveRule.taskType,
      selectedLevel: effectiveRule.requiredLevel,
      risk: effectiveRule.risk,
      reason: effectiveRule.reason,
      requireUserConfirmation: effectiveRule.requireUserConfirmation ?? false,
      createdAt: now,
      candidates: [] as string[],
      contextSignals: context?.signals,
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

    let strategy = effectiveRule.preferredStrategy ?? "single_model";
    if (
      strategy !== "rule_only" &&
      (input.forceSingleModel || input.allowCollaboration === false || input.qualityMode === "fast")
    ) {
      strategy = "single_model";
    } else if (
      strategy === "local_draft_remote_review" &&
      !effectiveRule.preferCollaboration &&
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
        reason: `${base.reason}；不调用模型${contextNote}`,
      };
    }

    if (strategy === "single_model") {
      const primary = this.registry.findPrimaryCandidates(effectiveRule, input.localOnly);
      if (primary.length === 0) {
        throw new RouterError("NO_AVAILABLE_MODEL", "没有可用模型满足当前任务要求");
      }
      const ranked = this.rankWithRuntimeFeedback(primary, effectiveRule.taskType);
      const evaluation = this.evaluator.evaluate({
        routerInput: input,
        rule: effectiveRule,
        candidates: ranked.candidates,
        routingContext: context,
      });
      let pick = ranked.candidates[0]!;
      let source: RouterDecision["source"] = "rule";
      let reason = base.reason;
      if (evaluation.shouldOverrideRule && evaluation.recommendedModelId) {
        const override = ranked.candidates.find((p) => p.id === evaluation.recommendedModelId);
        if (override) {
          pick = override;
          source = "evaluator";
          reason = `${base.reason}；V3 评估：${evaluation.reasons.join("，")}`;
        }
      }
      if (
        this.runtimeFeedback &&
        ranked.signals.length > 0 &&
        pick.id !== ranked.candidates[0]!.id
      ) {
        pick = ranked.candidates[0]!;
        source = "runtime_stats";
        reason = `${base.reason}；V8 运行反馈：${ranked.signals.join("，")}`;
      } else if (pick.id !== primary[0]!.id && source === "rule") {
        source = "runtime_stats";
        reason = `${base.reason}；V8 运行反馈：${ranked.signals.join("，")}`;
      }
      const contextSignals = [
        ...(context?.signals ?? []),
        ...ranked.signals.map((s) => `stats:${s}`),
      ];
      return {
        ...base,
        source,
        executionStrategy: "single_model",
        selectedModelId: pick.id,
        candidates: ranked.candidates.map((p) => p.id),
        contextSignals: contextSignals.length > 0 ? contextSignals : undefined,
        reason: `${reason}${contextNote}`,
      };
    }

    return this.decideCollaboration(effectiveRule, input, base, context, contextNote);
  }

  private rankWithRuntimeFeedback(
    candidates: ModelProfile[],
    taskType: TaskType,
  ): { candidates: ModelProfile[]; signals: string[] } {
    if (!this.runtimeFeedback || candidates.length <= 1) {
      return { candidates, signals: [] };
    }
    return this.runtimeFeedback.rankCandidates(candidates, taskType);
  }

  private decideCollaboration(
    rule: RuleRouteResult,
    input: RouterInput,
    base: Omit<RouterDecision, "source" | "executionStrategy" | "candidates"> & { candidates: string[] },
    routingContext?: RoutingContext,
    contextNote = "",
  ): RouterDecision {
    const tokenNeed = routingContext?.effectiveTokenEstimate ?? input.contextTokenEstimate;
    const draftRanked = this.rankWithRuntimeFeedback(
      this.registry.findDraftCandidates(rule, input.localOnly, tokenNeed),
      rule.taskType,
    );
    const reviewRanked = this.rankWithRuntimeFeedback(
      this.registry.findReviewCandidates(rule, input.localOnly),
      rule.taskType,
    );
    const drafts = draftRanked.candidates;
    const reviews = reviewRanked.candidates;
    const statsSignals = [...draftRanked.signals, ...reviewRanked.signals];
    const statsNote =
      statsSignals.length > 0 ? `；V8 运行反馈：${statsSignals.join("，")}` : "";
    const mergedContextSignals = [
      ...(routingContext?.signals ?? []),
      ...statsSignals.map((s) => `stats:${s}`),
    ];
    const withStats = {
      ...base,
      contextSignals: mergedContextSignals.length > 0 ? mergedContextSignals : base.contextSignals,
    };

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
      const ranked = this.rankWithRuntimeFeedback(primary, rule.taskType);
      const strong = ranked.candidates.find((p) => p.defaultLevel >= 3) ?? ranked.candidates[0]!;
      return {
        ...withStats,
        source: "fallback",
        executionStrategy: "single_model",
        selectedModelId: strong.id,
        candidates: ranked.candidates.map((p) => p.id),
        fallbackNote: "无审查模型，降级为 single_model",
        reason: `${base.reason}；无 review 模型${statsNote}${contextNote}`,
      };
    }

    const draft = drafts[0];
    const review = reviews[0]!;
    const allCandidates = [...new Set([...(draft ? [draft.id] : []), ...reviews.map((r) => r.id)])];

    if (!draft) {
      if (rule.risk === "low") {
        return {
          ...withStats,
          source: "fallback",
          executionStrategy: "single_model",
          selectedModelId: review.id,
          candidates: allCandidates,
          fallbackNote: "无草稿模型，直接使用审查模型",
          reason: `${base.reason}${statsNote}${contextNote}`,
        };
      }
      return {
        ...withStats,
        source: "fallback",
        executionStrategy: "single_model",
        selectedModelId: review.id,
        candidates: allCandidates,
        fallbackNote: "无草稿模型，中高风险改用强单模型",
        reason: `${base.reason}${statsNote}${contextNote}`,
      };
    }

    return {
      ...withStats,
      source: "rule",
      executionStrategy: "local_draft_remote_review",
      draftModelId: draft.id,
      reviewModelId: review.id,
      finalModelId: review.id,
      candidates: allCandidates,
      reason: `${base.reason}${statsNote}${contextNote}`,
    };
  }
}
