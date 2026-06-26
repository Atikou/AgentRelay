import type { CollaborationRunStore } from "../../model-router/route-stores.js";
import type { RouterDecision } from "../../model-router/types.js";
import type { ModelResponse } from "../../model/types.js";
import { buildParallelVoteJudgeMessages } from "../prompt-templates/parallel-vote-judge-prompt.js";
import type {
  ModelChatFn,
  OrchestratorInput,
  OrchestratorResult,
  PipelineFallbackContext,
} from "../types.js";
import { runSingleModelPipeline } from "./single-model-pipeline.js";

export interface ParallelVoteCandidate {
  modelId: string;
  answer: string;
  callLogId: string;
}

export interface ParallelVoteResult {
  winnerIndex: number;
  winnerModelId: string;
  reason?: string;
  candidates: ParallelVoteCandidate[];
}

interface VoteRunCandidate extends ParallelVoteCandidate {
  index: number;
  response: ModelResponse;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] ?? text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("裁决输出不是 JSON");
  return JSON.parse(raw.slice(start, end + 1));
}

export function parseParallelVoteJudge(content: string): { winnerIndex: number; reason?: string } {
  const json = extractJson(content) as Record<string, unknown>;
  const winnerIndex = json.winnerIndex;
  if (typeof winnerIndex !== "number" || winnerIndex < 0) {
    throw new Error("winnerIndex 无效");
  }
  return {
    winnerIndex,
    reason: typeof json.reason === "string" ? json.reason : undefined,
  };
}

function pickHeuristicWinner(candidates: ParallelVoteCandidate[]): ParallelVoteResult {
  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < candidates.length; i += 1) {
    const text = candidates[i]!.answer.trim();
    const score = text.length >= 20 ? text.length : text.length * 0.1;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  const winner = candidates[bestIdx]!;
  return {
    winnerIndex: bestIdx,
    winnerModelId: winner.modelId,
    reason: "heuristic_longest_substantive",
    candidates,
  };
}

function toPublicCandidates(candidates: VoteRunCandidate[]): ParallelVoteCandidate[] {
  return candidates.map((v) => ({
    modelId: v.modelId,
    answer: v.answer,
    callLogId: v.callLogId,
  }));
}

function recordAndApply(
  ctx: PipelineFallbackContext,
  decision: RouterDecision,
  sessionId: string | undefined,
  plan: NonNullable<ReturnType<PipelineFallbackContext["manager"]["plan"]>>,
): RouterDecision {
  const logId = ctx.logStore.create({
    routeLogId: decision.id,
    sessionId,
    fromModelId: plan.fromModelId,
    toModelId: plan.toModelId,
    fromStrategy: plan.fromStrategy,
    toStrategy: plan.toStrategy,
    triggerType: plan.trigger,
    reason: plan.reason,
  });
  ctx.recordFallback(logId);
  return ctx.manager.applyPlan(decision, plan);
}

export async function runParallelVotePipeline(
  input: OrchestratorInput,
  chat: ModelChatFn,
  collaborationStore: CollaborationRunStore,
  fallbackCtx: PipelineFallbackContext,
): Promise<OrchestratorResult> {
  const decision = input.routerDecision;
  const voteIds =
    decision.voteModelIds ??
    [decision.draftModelId, decision.finalModelId].filter((id): id is string => Boolean(id));
  const judgeId = decision.judgeModelId ?? decision.reviewModelId;
  if (voteIds.length < 2) {
    throw new Error("parallel_vote 缺少 voteModelIds");
  }

  const collaborationRunId = collaborationStore.create({
    routeLogId: decision.id,
    sessionId: input.sessionId,
    strategy: "parallel_vote",
    draftModelId: voteIds[0],
    reviewModelId: judgeId,
    finalModelId: voteIds[1],
  });

  const modelCallIds: string[] = [];
  const usedModelIds: string[] = [];

  const voteSettled = await Promise.allSettled(
    voteIds.map(async (modelId, index) => {
      const { response, callLogId } = await chat(
        modelId,
        {
          messages: input.renderedPrompt.finalMessages,
          temperature: input.temperature ?? 0.35,
          signal: input.signal,
        },
        {
          role: "primary",
          routeLogId: decision.id,
          collaborationRunId,
          sessionId: input.sessionId,
        },
      );
      modelCallIds.push(callLogId);
      if (!usedModelIds.includes(modelId)) usedModelIds.push(modelId);
      return { index, modelId, answer: response.content, callLogId, response };
    }),
  );
  const voteResults = voteSettled
    .filter((r): r is PromiseFulfilledResult<VoteRunCandidate> => r.status === "fulfilled")
    .map((r) => r.value);
  const voteFailures = voteSettled.filter((r): r is PromiseRejectedResult => r.status === "rejected");

  if (voteResults.length === 0) {
    collaborationStore.finish(collaborationRunId, {
      status: "vote_failed",
      verdict: "reject",
      issuesJson: JSON.stringify(
        voteFailures.map((f) => ({
          severity: "high",
          message: `parallel_vote voter failed: ${String(f.reason)}`,
        })),
      ),
    });
    throw new Error(`并行投票模型全部失败：${String(voteFailures[0]?.reason ?? "unknown")}`);
  }

  let voteResult: ParallelVoteResult;
  if (judgeId && voteResults.length >= 2) {
    try {
      const judgeMessages = buildParallelVoteJudgeMessages(
        input.userInput,
        voteResults.map((v) => ({ index: v.index, modelId: v.modelId, answer: v.answer })),
      );
      const judgeRes = await chat(
        judgeId,
        { messages: judgeMessages, temperature: 0.1, signal: input.signal },
        {
          role: "review",
          routeLogId: decision.id,
          collaborationRunId,
          sessionId: input.sessionId,
        },
      );
      modelCallIds.push(judgeRes.callLogId);
      if (!usedModelIds.includes(judgeId)) usedModelIds.push(judgeId);
      const parsed = parseParallelVoteJudge(judgeRes.response.content);
      if (parsed.winnerIndex >= voteResults.length) {
        throw new Error(`winnerIndex 越界：${parsed.winnerIndex}`);
      }
      const winner = voteResults[parsed.winnerIndex]!;
      voteResult = {
        winnerIndex: parsed.winnerIndex,
        winnerModelId: winner.modelId,
        reason: parsed.reason,
        candidates: toPublicCandidates(voteResults),
      };
    } catch {
      voteResult = pickHeuristicWinner(toPublicCandidates(voteResults));
    }
  } else {
    voteResult = pickHeuristicWinner(toPublicCandidates(voteResults));
  }

  const winnerAnswer =
    voteResult.candidates[voteResult.winnerIndex]?.answer ??
    voteResult.candidates[0]?.answer ??
    "";
  const winnerRun =
    voteResults[voteResult.winnerIndex] ??
    voteResults.find((v) => v.modelId === voteResult.winnerModelId);
  const winnerResponse = winnerRun?.response;

  if (!winnerAnswer.trim()) {
    const plan = fallbackCtx.manager.plan(decision, "empty_output", {
      fromModelId: voteResult.winnerModelId,
      usedModelIds,
      localOnly: fallbackCtx.localOnly,
    });
    if (!plan) {
      collaborationStore.finish(collaborationRunId, {
        status: "vote_empty_failed",
        verdict: "reject",
      });
      throw new Error("并行投票结果为空且无法 fallback");
    }
    const nextDecision = recordAndApply(fallbackCtx, decision, input.sessionId, plan);
    let direct: OrchestratorResult;
    try {
      direct = await runSingleModelPipeline({ ...input, routerDecision: nextDecision }, chat);
    } catch (error) {
      collaborationStore.finish(collaborationRunId, {
        status: "vote_empty_fallback_failed",
        verdict: "reject",
      });
      throw error;
    }
    collaborationStore.finish(collaborationRunId, {
      status: "vote_empty_fallback",
      verdict: "revise",
    });
    return {
      ...direct,
      collaborationRunId,
      modelCallIds: [...modelCallIds, ...direct.modelCallIds],
      usedModelIds: [...usedModelIds, ...direct.usedModelIds],
    };
  }

  const degraded = voteResults.length < voteIds.length;
  collaborationStore.finish(collaborationRunId, {
    status: degraded ? "vote_degraded_single" : "completed",
    verdict: degraded ? "revise" : "approve",
    confidence: 1,
    issuesJson: JSON.stringify([
      {
        severity: degraded ? "medium" : "low",
        message: `parallel_vote winner=${voteResult.winnerModelId} reason=${voteResult.reason ?? "n/a"}`,
      },
      ...voteFailures.map((f) => ({
        severity: "medium",
        message: `parallel_vote voter failed: ${String(f.reason)}`,
      })),
    ]),
  });

  return {
    finalAnswer: winnerAnswer,
    usedStrategy: "parallel_vote",
    usedModelIds,
    collaborationRunId,
    modelCallIds,
    voteResult,
    clientName: winnerResponse?.clientName,
    modelName: winnerResponse?.modelName,
    location: winnerResponse?.location,
    latencyMs: winnerResponse?.latencyMs,
    usage: winnerResponse?.usage,
  };
}
