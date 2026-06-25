import type { AgentIntentType } from "../IntentTypes.js";
import type { AgentRunMode, AgentStopReason } from "../RunPolicyTypes.js";
import type { AgentToolStep } from "../toolStep.js";
import { augmentContractWithEscalations } from "../capabilityEscalationRuntime.js";
import { buildTaskCompletionContract } from "./TaskCompletionContract.js";
import { buildToolLedger } from "./ToolLedger.js";

export type CompletionStatus =
  | "completed_success"
  | "completed_partial"
  | "awaiting_permission"
  | "blocked_by_policy"
  | "misleading_completion";

export interface CompletionGuardResult {
  /** 是否接受本轮模型 raw final 作为 trusted final_answer。 */
  accepted: boolean;
  status: CompletionStatus;
  stopReason: AgentStopReason;
  reason: string;
  contract: ReturnType<typeof buildTaskCompletionContract>;
  ledger: ReturnType<typeof buildToolLedger>;
  /** 仅 role=system 回灌模型（当前 run 继续时）。 */
  systemFeedback?: string;
  /** Guard 后用户可见、可持久化的可信回答（source=guard）。 */
  guardedAnswer?: string;
  /** 模型原始 final，仅 trace / raw_model_final 持久化。 */
  rawModelAnswer?: string;
}

const SUCCESS_CLAIM_RE =
  /已成功|已安装|安装完成|已修改|修改完成|已写入|写入完成|已执行|执行完成|已完成|增强方案执行|变更\s*ID|npm install.*成功/i;

/** 模型引用历史/先前状态，而非声称本轮刚执行副作用。 */
const HISTORICAL_COMPLETION_RE =
  /根据历史|历史记录|已在之前|之前.*成功|先前.*完成|上一轮|过往.*安装|无需额外操作|当前依赖已就绪|无需再.*安装|已就绪，无需/i;

function claimsHistoricalOrPriorCompletion(answer: string): boolean {
  return HISTORICAL_COMPLETION_RE.test(answer);
}

/** 声称本轮/当前执行已成功（不含纯历史引用）。 */
function claimsCurrentRunSideEffectSuccess(answer: string): boolean {
  if (claimsHistoricalOrPriorCompletion(answer)) return false;
  return SUCCESS_CLAIM_RE.test(answer);
}

/** @deprecated 使用 claimsCurrentRunSideEffectSuccess */
function claimsSideEffectSuccess(answer: string): boolean {
  return claimsCurrentRunSideEffectSuccess(answer);
}

function blockedRequiredSideEffectSteps(
  steps: AgentToolStep[],
  kind: "shell" | "write",
): AgentToolStep[] {
  return steps.filter((step) => {
    if (!step.blocked) return false;
    if (kind === "shell") return step.tool === "shell_run" || step.permission === "shell";
    return step.tool === "write_file" || step.tool === "apply_patch" || step.permission === "write";
  });
}

/** 构造 Guard 后用户可见的可信 final（messageKind=final_answer, source=guard）。 */
export function buildGuardedFinalAnswer(input: {
  goal: string;
  status: CompletionStatus;
  reason: string;
  ledger: ReturnType<typeof buildToolLedger>;
  blockedSteps: AgentToolStep[];
}): string {
  const shellBlocked = input.blockedSteps.find(
    (s) => s.tool === "shell_run" || s.permission === "shell",
  );
  const writeBlocked = input.blockedSteps.find(
    (s) => s.tool === "write_file" || s.tool === "apply_patch" || s.permission === "write",
  );

  if (input.status === "awaiting_permission" && shellBlocked) {
    const cmd =
      (shellBlocked.input as { command?: string } | undefined)?.command ?? "shell 命令";
    return [
      `依赖尚未安装完成。`,
      `本轮尝试执行：${cmd}`,
      `但 shell 权限未授权，因此命令没有实际运行。`,
      `请在权限弹窗中授权 shell 后继续。`,
    ].join("\n");
  }

  if (input.status === "awaiting_permission" && writeBlocked) {
    const path =
      (writeBlocked.input as { path?: string } | undefined)?.path ??
      writeBlocked.outcomePath ??
      "目标文件";
    return [
      `任务「${input.goal}」尚未完成。`,
      `写入操作（${path}）被权限策略阻止，尚未执行。`,
      `请授权写入权限后继续。`,
    ].join("\n");
  }

  if (input.status === "blocked_by_policy") {
    return [
      `任务「${input.goal}」尚未完成。`,
      input.reason,
      `Tool Ledger：shell 成功 ${input.ledger.successfulShellCalls} 次 / 写成功 ${input.ledger.successfulWriteCalls} 次。`,
      `当前工作流或模式不允许所需副作用，请调整策略后重试。`,
    ].join("\n");
  }

  const lines = [
    `任务「${input.goal}」尚未真实完成。`,
    input.reason,
    `Tool Ledger：shell 成功 ${input.ledger.successfulShellCalls} 次 / 写成功 ${input.ledger.successfulWriteCalls} 次。`,
  ];
  if (input.status === "misleading_completion") {
    lines.push("模型曾声称任务已完成，但副作用未在 Tool Ledger 中成功执行。");
  }
  lines.push("请授权必要工具或继续执行后再确认完成。");
  return lines.join("\n");
}

/** 构造仅回灌模型的 system 事实（非用户可见回答）。 */
export function buildGuardSystemFeedback(input: {
  goal: string;
  reason: string;
  status: CompletionStatus;
  ledger: ReturnType<typeof buildToolLedger>;
  blockedSteps: AgentToolStep[];
}): string {
  const blockedDesc = input.blockedSteps
    .map((s) => `${s.tool}${s.error ? `: ${s.error}` : ""}`)
    .join("；");
  return [
    "【系统执行事实 · 仅供你修正决策，不是用户消息】",
    `任务：${input.goal}`,
    `completionStatus：${input.status}`,
    `原因：${input.reason}`,
    `Tool Ledger：shell 成功 ${input.ledger.successfulShellCalls} 次 / 写成功 ${input.ledger.successfulWriteCalls} 次`,
    blockedDesc ? `被阻塞工具：${blockedDesc}` : "",
    "请根据以上事实继续：调用必要工具完成副作用，或向用户如实说明尚未完成；禁止在未执行副作用时声称已完成。",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 副作用任务 final 真实性校验。
 * 接受时 trusted final 来自模型；拒绝时 guardedAnswer 为 UI/历史可信回答。
 */
export function evaluateCompletionGuard(input: {
  goal: string;
  intent: AgentIntentType;
  mode: AgentRunMode;
  answer: string;
  steps: AgentToolStep[];
  stopReason?: AgentStopReason;
  awaitingPermission?: boolean;
  /** capability escalation 后的有效 intent（用于 completion contract）。 */
  reconciledIntent?: AgentIntentType;
  capabilityEscalations?: import("../CapabilityEscalation.js").CapabilityEscalationRecord[];
}): CompletionGuardResult {
  const effectiveIntent = input.reconciledIntent ?? input.intent;
  const baseContract = buildTaskCompletionContract({
    goal: input.goal,
    intent: effectiveIntent,
    mode: input.mode,
  });
  const contract = augmentContractWithEscalations(baseContract, input.capabilityEscalations);
  const ledger = buildToolLedger(input.steps);

  if (input.awaitingPermission || input.stopReason === "awaiting_permission") {
    return {
      accepted: true,
      status: "awaiting_permission",
      stopReason: "awaiting_permission",
      reason: "等待用户授权必要副作用工具",
      contract,
      ledger,
    };
  }

  if (!contract.requiresSideEffect) {
    return {
      accepted: true,
      status: "completed_success",
      stopReason: input.stopReason ?? "completed",
      reason: "问答/只读任务，无需副作用校验",
      contract,
      ledger,
    };
  }

  const needsShell = contract.requiredSideEffects.includes("shell");
  const needsWrite = contract.requiredSideEffects.includes("write");
  const shellOk = !needsShell || ledger.successfulShellCalls > 0;
  const writeOk = !needsWrite || ledger.successfulWriteCalls > 0;

  if (shellOk && writeOk) {
    return {
      accepted: true,
      status: "completed_success",
      stopReason: "completed",
      reason: "所需副作用已在 Tool Ledger 中成功执行",
      contract,
      ledger,
    };
  }

  // 模型基于历史/上下文说明先前已完成，而非声称本轮刚执行 shell/write → 接受模型 final
  if (claimsHistoricalOrPriorCompletion(input.answer) && !claimsCurrentRunSideEffectSuccess(input.answer)) {
    return {
      accepted: true,
      status: "completed_success",
      stopReason: "completed",
      reason: "模型基于历史或上下文说明任务状态，本轮未重新执行副作用",
      contract,
      ledger,
    };
  }

  const blockedShell = blockedRequiredSideEffectSteps(input.steps, "shell");
  const blockedWrite = blockedRequiredSideEffectSteps(input.steps, "write");
  const workflowBlocked = [...blockedShell, ...blockedWrite].some(
    (s) => s.blockedReasonKind === "workflow",
  );
  const permissionBlocked = [...blockedShell, ...blockedWrite].some(
    (s) => s.blockedReasonKind === "permission" || s.outcomeKind === "permission_denied",
  );

  let status: CompletionStatus = "completed_partial";
  let stopReason: AgentStopReason = "completed_partial";
  let reason = "所需副作用未成功执行";

  if (workflowBlocked) {
    status = "blocked_by_policy";
    stopReason = "blocked_by_policy";
    reason = "当前工作流/模式不允许所需副作用";
  } else if (permissionBlocked) {
    status = "awaiting_permission";
    stopReason = "awaiting_permission";
    reason = "必要副作用工具被权限策略阻止，尚未执行";
  } else if (claimsCurrentRunSideEffectSuccess(input.answer)) {
    status = "misleading_completion";
    stopReason = "misleading_completion";
    reason = "模型声称本轮任务已完成，但 Tool Ledger 无对应成功副作用";
  }

  // 未虚假声称本轮完成：保留模型原文，仅以 executionMeta 标记 partial
  if (!claimsCurrentRunSideEffectSuccess(input.answer)) {
    return {
      accepted: true,
      status,
      stopReason,
      reason,
      contract,
      ledger,
    };
  }

  return {
    accepted: false,
    status,
    stopReason,
    reason,
    contract,
    ledger,
    rawModelAnswer: input.answer,
    guardedAnswer: buildGuardedFinalAnswer({
      goal: input.goal,
      status,
      reason,
      ledger,
      blockedSteps: [...blockedShell, ...blockedWrite],
    }),
    systemFeedback: buildGuardSystemFeedback({
      goal: input.goal,
      reason,
      status,
      ledger,
      blockedSteps: [...blockedShell, ...blockedWrite],
    }),
  };
}

export function sideEffectsSatisfiedForContract(
  contract: ReturnType<typeof buildTaskCompletionContract>,
  ledger: ReturnType<typeof buildToolLedger>,
): boolean {
  if (!contract.requiresSideEffect) return true;
  if (contract.requiredSideEffects.includes("shell") && ledger.successfulShellCalls === 0) return false;
  if (contract.requiredSideEffects.includes("write") && ledger.successfulWriteCalls === 0) return false;
  return true;
}
