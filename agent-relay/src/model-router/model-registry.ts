import type { ModelProfile, RuleRouteResult, TaskType } from "./types.js";

const COST_ORDER: Record<ModelProfile["relativeCost"], number> = {
  free: 0,
  low: 1,
  medium: 2,
  high: 3,
};

const DRAFT_GENERAL_TYPES: TaskType[] = ["technical_qa", "simple_qa", "summary", "document_qa"];

function taskAllowed(profile: ModelProfile, taskType: TaskType): boolean {
  return profile.allowedTaskTypes.includes(taskType) || profile.allowedTaskTypes.includes("unknown");
}

function meetsRequirements(profile: ModelProfile, rule: RuleRouteResult): boolean {
  if (rule.requireVision && !profile.supportsVision) return false;
  if (rule.requireTools && !profile.supportsTools) return false;
  if (rule.requireJsonMode && !profile.supportsJsonMode) return false;
  return true;
}

function sortPrimary(a: ModelProfile, b: ModelProfile, requiredLevel: number): number {
  const levelDiff = Math.abs(a.defaultLevel - requiredLevel) - Math.abs(b.defaultLevel - requiredLevel);
  if (levelDiff !== 0) return levelDiff;
  const costDiff = COST_ORDER[a.relativeCost] - COST_ORDER[b.relativeCost];
  if (costDiff !== 0) return costDiff;
  return (a.avgLatencyMs ?? 9999) - (b.avgLatencyMs ?? 9999);
}

function sortDraft(a: ModelProfile, b: ModelProfile): number {
  const localFirst = (a.provider === "local" ? 0 : 1) - (b.provider === "local" ? 0 : 1);
  if (localFirst !== 0) return localFirst;
  const costDiff = COST_ORDER[a.relativeCost] - COST_ORDER[b.relativeCost];
  if (costDiff !== 0) return costDiff;
  return (a.avgLatencyMs ?? 9999) - (b.avgLatencyMs ?? 9999);
}

function sortReview(a: ModelProfile, b: ModelProfile, requiredLevel: number): number {
  const levelOk = (p: ModelProfile) => (p.defaultLevel >= requiredLevel ? 0 : 1);
  const l = levelOk(a) - levelOk(b);
  if (l !== 0) return l;
  const jsonFirst = (p: ModelProfile) => (p.supportsJsonMode ? 0 : 1);
  const j = jsonFirst(a) - jsonFirst(b);
  if (j !== 0) return j;
  return sortPrimary(a, b, requiredLevel);
}

export class ModelRegistry {
  constructor(private readonly profiles: ModelProfile[]) {}

  listEnabled(localOnly?: boolean): ModelProfile[] {
    return this.profiles.filter(
      (p) => p.enabled && (!localOnly || p.provider === "local"),
    );
  }

  get(id: string): ModelProfile | undefined {
    return this.profiles.find((p) => p.id === id);
  }

  findPrimaryCandidates(rule: RuleRouteResult, localOnly?: boolean): ModelProfile[] {
    return this.listEnabled(localOnly)
      .filter(
        (p) =>
          p.canFinal &&
          p.allowedRoles.includes("primary") &&
          p.defaultLevel >= rule.requiredLevel &&
          taskAllowed(p, rule.taskType) &&
          meetsRequirements(p, rule),
      )
      .sort((a, b) => sortPrimary(a, b, rule.requiredLevel));
  }

  findDraftCandidates(
    rule: RuleRouteResult,
    localOnly?: boolean,
    contextTokenEstimate?: number,
  ): ModelProfile[] {
    const tokenNeed = contextTokenEstimate ?? 8000;
    return this.listEnabled(localOnly)
      .filter(
        (p) =>
          p.canDraft &&
          p.allowedRoles.includes("draft") &&
          (taskAllowed(p, rule.taskType) ||
            DRAFT_GENERAL_TYPES.some((t) => p.allowedTaskTypes.includes(t))) &&
          p.maxInputTokens >= tokenNeed,
      )
      .sort(sortDraft);
  }

  findReviewCandidates(rule: RuleRouteResult, localOnly?: boolean): ModelProfile[] {
    return this.listEnabled(localOnly)
      .filter(
        (p) =>
          p.canReview &&
          p.allowedRoles.includes("review") &&
          p.defaultLevel >= rule.requiredLevel &&
          taskAllowed(p, rule.taskType) &&
          meetsRequirements(p, rule),
      )
      .sort((a, b) => sortReview(a, b, rule.requiredLevel));
  }

  findFinalCandidates(rule: RuleRouteResult, localOnly?: boolean): ModelProfile[] {
    return this.findReviewCandidates(rule, localOnly).filter((p) => p.canFinal);
  }
}
