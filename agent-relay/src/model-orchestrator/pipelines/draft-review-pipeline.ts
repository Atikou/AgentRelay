import type { CollaborationRunStore } from "../../model-router/route-stores.js";
import type { RouterDecision, RiskLevel } from "../../model-router/types.js";
import { buildDraftMessages } from "../prompt-templates/draft-prompt.js";
import { buildReviewMessages } from "../prompt-templates/review-prompt.js";
import type {
  DraftReviewResult,
  ModelChatFn,
  ModelChatResult,
  OrchestratorInput,
  OrchestratorResult,
} from "../types.js";

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] ?? text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("审查输出不是 JSON");
  return JSON.parse(raw.slice(start, end + 1));
}

export function parseDraftReviewResult(content: string): DraftReviewResult {
  const json = extractJson(content) as Record<string, unknown>;
  const verdict = json.verdict;
  if (verdict !== "approve" && verdict !== "revise" && verdict !== "reject") {
    throw new Error("verdict 无效");
  }
  const issues = Array.isArray(json.issues)
    ? json.issues.map((i: Record<string, unknown>) => ({
        severity: (i.severity === "high" || i.severity === "medium" ? i.severity : "low") as
          | "low"
          | "medium"
          | "high",
        message: String(i.message ?? ""),
      }))
    : [];
  return {
    verdict,
    confidence: typeof json.confidence === "number" ? json.confidence : 0,
    issues,
    revisedAnswer: json.revisedAnswer ? String(json.revisedAnswer) : undefined,
  };
}

export async function runDraftReviewPipeline(
  input: OrchestratorInput,
  chat: ModelChatFn,
  collaborationStore: CollaborationRunStore,
  risk: RiskLevel,
): Promise<OrchestratorResult> {
  const decision = input.routerDecision;
  const draftId = decision.draftModelId;
  const reviewId = decision.reviewModelId ?? decision.finalModelId;
  if (!draftId || !reviewId) {
    throw new Error("local_draft_remote_review 缺少 draft/review 模型");
  }

  const collaborationRunId = collaborationStore.create({
    sessionId: input.sessionId,
    routeLogId: decision.id,
    strategy: decision.executionStrategy,
    draftModelId: draftId,
    reviewModelId: reviewId,
    finalModelId: decision.finalModelId,
  });

  const modelCallIds: string[] = [];
  const usedModelIds: string[] = [];
  let draftText = "";
  let lastResponse: ModelChatResult["response"] | undefined;

  try {
    const draftMessages = buildDraftMessages(input.renderedPrompt.finalMessages, input.userInput);
    const draftRes = await chat(
      draftId,
      { messages: draftMessages, temperature: input.temperature ?? 0.3 },
      { role: "draft", routeLogId: decision.id, collaborationRunId, sessionId: input.sessionId },
    );
    modelCallIds.push(draftRes.callLogId);
    usedModelIds.push(draftId);
    lastResponse = draftRes.response;
    draftText = draftRes.response.content;
  } catch {
    if (risk === "low") {
      const fallback = await chat(
        reviewId,
        {
          messages: input.renderedPrompt.finalMessages,
          temperature: input.temperature ?? 0.3,
        },
        { role: "primary", routeLogId: decision.id, collaborationRunId, sessionId: input.sessionId },
      );
      modelCallIds.push(fallback.callLogId);
      collaborationStore.finish(collaborationRunId, { status: "draft_failed_single", verdict: "revise" });
      return finalize(fallback.response, "single_model", [reviewId], modelCallIds, collaborationRunId);
    }
    const regen = await chat(
      reviewId,
      { messages: input.renderedPrompt.finalMessages, temperature: input.temperature ?? 0.3 },
      { role: "final", routeLogId: decision.id, collaborationRunId, sessionId: input.sessionId },
    );
    modelCallIds.push(regen.callLogId);
    collaborationStore.finish(collaborationRunId, { status: "draft_failed_final", verdict: "reject" });
    return finalize(regen.response, "local_draft_remote_review", [reviewId], modelCallIds, collaborationRunId);
  }

  let reviewResult: DraftReviewResult | undefined;
  try {
    const reviewMessages = buildReviewMessages(input.userInput, draftText);
    let reviewContent = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reviewRes = await chat(
        reviewId,
        { messages: reviewMessages, temperature: 0.1 },
        { role: "review", routeLogId: decision.id, collaborationRunId, sessionId: input.sessionId },
      );
      lastResponse = reviewRes.response;
      if (!usedModelIds.includes(reviewId)) usedModelIds.push(reviewId);
      modelCallIds.push(reviewRes.callLogId);
      reviewContent = reviewRes.response.content;
      try {
        reviewResult = parseDraftReviewResult(reviewContent);
        break;
      } catch {
        if (attempt === 1) throw new Error("审查 JSON 解析失败");
      }
    }
  } catch {
    if (risk === "low") {
      collaborationStore.finish(collaborationRunId, {
        status: "review_failed_used_draft",
        verdict: "approve",
        confidence: 0,
        issuesJson: JSON.stringify([{ severity: "low", message: "review_failed" }]),
      });
      return {
        finalAnswer: draftText,
        usedStrategy: "local_draft_remote_review",
        usedModelIds,
        collaborationRunId,
        modelCallIds,
        clientName: lastResponse?.clientName,
        modelName: lastResponse?.modelName,
        location: lastResponse?.location,
        latencyMs: lastResponse?.latencyMs,
        usage: lastResponse?.usage,
      };
    }
    const regen = await chat(
      reviewId,
      { messages: input.renderedPrompt.finalMessages, temperature: input.temperature ?? 0.3 },
      { role: "final", routeLogId: decision.id, collaborationRunId, sessionId: input.sessionId },
    );
    modelCallIds.push(regen.callLogId);
    collaborationStore.finish(collaborationRunId, { status: "review_failed_regen", verdict: "reject" });
    return finalize(regen.response, "local_draft_remote_review", usedModelIds, modelCallIds, collaborationRunId);
  }

  if (!reviewResult) {
    throw new Error("审查结果为空");
  }

  let finalAnswer: string;
  if (reviewResult.verdict === "approve") {
    finalAnswer = draftText;
  } else if (reviewResult.revisedAnswer?.trim()) {
    finalAnswer = reviewResult.revisedAnswer.trim();
  } else if (risk === "high") {
    throw new Error("审查 reject 且无 revisedAnswer，高风险任务拒绝使用草稿");
  } else {
    finalAnswer = draftText;
  }

  collaborationStore.finish(collaborationRunId, {
    status: "completed",
    verdict: reviewResult.verdict,
    confidence: reviewResult.confidence,
    issuesJson: JSON.stringify(reviewResult.issues),
  });

  return {
    finalAnswer,
    usedStrategy: "local_draft_remote_review",
    usedModelIds,
    collaborationRunId,
    modelCallIds,
    reviewResult,
    clientName: lastResponse?.clientName,
    modelName: lastResponse?.modelName,
    location: lastResponse?.location,
    latencyMs: lastResponse?.latencyMs,
    usage: lastResponse?.usage,
  };
}

function finalize(
  response: ModelChatResult["response"],
  strategy: OrchestratorResult["usedStrategy"],
  usedModelIds: string[],
  modelCallIds: string[],
  collaborationRunId?: string,
): OrchestratorResult {
  return {
    finalAnswer: response.content,
    usedStrategy: strategy,
    usedModelIds,
    collaborationRunId,
    modelCallIds,
    clientName: response.clientName,
    modelName: response.modelName,
    location: response.location,
    latencyMs: response.latencyMs,
    usage: response.usage,
  };
}
