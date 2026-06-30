import type { ToolPermission } from "../core/permissions.js";
import type { ContextManager } from "../context/ContextManager.js";
import { evaluatePermissionGuard } from "../policy/PermissionGuard.js";
import type { NetworkPolicy } from "../policy/NetworkPolicy.js";
import type { ShellPolicy } from "../policy/ShellPolicy.js";
import type { ToolPathPreparation } from "../policy/PathPolicy.js";
import type { ScopedApprovedPermissions } from "../policy/permissionRequestTypes.js";
import type { WorkspaceGrantStore, WorkspaceScopePermission } from "../policy/WorkspaceScopeManager.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { ToolOutcome } from "../tools/toolOutcome.js";
import { resolveToolOutcome } from "../tools/toolOutcome.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import { buildToolResultLayers } from "../util/toolResultLayers.js";
import type { ToolAction } from "./AgentActionParser.js";
import { AgentToolActivityTracker } from "./AgentToolActivityTracker.js";
import type { BudgetManager } from "./BudgetManager.js";
import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";
import type { FailedActionMemory } from "./recovery/FailedActionMemory.js";
import { applyOutcomeToStep, traceStatusForOutcome } from "./recovery/renderToolOutcome.js";
import type { RunToolResultCache } from "./recovery/RunToolResultCache.js";
import type { UserPermissionPolicy } from "./RunPolicyTypes.js";
import {
  assessSubagentDispatchGuard,
  assessSubagentSideEffectGuard,
} from "./SubagentDispatchGuard.js";
import type { AgentTimelineService } from "./timeline/AgentTimelineService.js";
import type { AgentToolStep } from "./toolStep.js";
import { ToolExecutionGateway } from "./ToolExecutionGateway.js";
import type { WorkflowWriteOrchestratorResult } from "./workflowWriteOrchestrator.js";

export interface AgentToolActionRunContext {
  registry: ToolRegistry;
  toolGateway: ToolExecutionGateway;
  timeline?: AgentTimelineService;
  runId?: string;
  sessionId?: string;
  taskId?: string;
  requestId?: string;
  trace?: TraceLogger;
  workspaceRoot: string;
  workspaceGrantStore?: WorkspaceGrantStore;
  workspaceConfigScopes?: Array<{
    id: string;
    rootPath: string;
    label?: string;
    permissions?: WorkspaceScopePermission[];
  }>;
  signal?: AbortSignal;
  sensitive?: boolean;
  subAgentDispatchDepth?: number;
  maxSubAgentDispatchDepth?: number;
  projectAllowedPermissions?: ToolPermission[];
  contextManager?: ContextManager;
  allowedPermissions: ToolPermission[];
  permissionPolicy: UserPermissionPolicy;
  reconciledWorkflowType?: AgentWorkflowType;
  policyWorkflowType: AgentWorkflowType;
  getIntent: () => AgentIntentType;
  shellPolicy?: ShellPolicy;
  networkPolicy?: NetworkPolicy;
  isToolExposed: (toolName: string) => boolean;
  preparePathAccess: (action: ToolAction) => ToolPathPreparation | undefined;
  resolveScopedGrants: () => ScopedApprovedPermissions | undefined;
  failedActionMemory: FailedActionMemory;
  toolResultCache: RunToolResultCache;
  budgetManager: BudgetManager;
  buildPathBlockedStep: (
    action: ToolAction,
    iteration: number,
    pathAccess: ToolPathPreparation,
    toolCallId?: string,
  ) => AgentToolStep;
  workflowWriteOrchestration: (input: {
    tool: string;
    steps: AgentToolStep[];
    goal: string;
  }) => WorkflowWriteOrchestratorResult;
}

export interface RunAgentToolActionInput {
  action: ToolAction;
  iteration: number;
  toolCallId: string;
  steps: AgentToolStep[];
  goal: string;
  isRecovery?: boolean;
  isPreflight?: boolean;
}

export interface AgentToolActionRunResult {
  step: AgentToolStep;
  workflowWrite?: WorkflowWriteOrchestratorResult;
}

function buildCachedToolStep(
  ctx: AgentToolActionRunContext,
  base: AgentToolStep,
  tool: NonNullable<ReturnType<ToolRegistry["get"]>>,
  cachedOutput: unknown,
): AgentToolStep {
  const layers = buildToolResultLayers(base.tool, cachedOutput, {
    compact: ctx.contextManager
      ? (t, out) => ctx.contextManager!.compactToolOutput(t, out)
      : undefined,
  });
  const outcome = resolveToolOutcome(base.tool, cachedOutput);
  ctx.budgetManager.recordCacheHit();
  return applyOutcomeToStep(
    { ...base, permission: tool.permission },
    outcome,
    {
      executed: false,
      cached: true,
      output: layers.modelVisible,
      resultLayers: layers,
      toolCallId: base.toolCallId,
    },
  );
}

function recordPathAccessAudit(
  ctx: AgentToolActionRunContext,
  input: {
    action: ToolAction;
    toolCallId: string;
    pathAccess: ToolPathPreparation;
  },
): void {
  ctx.trace?.write({
    type: "path_access_decision",
    tool: input.action.tool,
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    taskId: ctx.taskId,
    toolCallId: input.toolCallId,
    allowed: input.pathAccess.decision.allowed,
    needsConfirmation: input.pathAccess.decision.needsConfirmation,
    reason: input.pathAccess.decision.reason,
    operation: input.pathAccess.decision.requiredPermission,
    normalizedPath: input.pathAccess.decision.normalizedPath,
    matchedRoot: input.pathAccess.audit.matchedRoot,
    crossWorkspace: input.pathAccess.audit.crossWorkspace,
    permissionSource: input.pathAccess.audit.permissionSource,
    pathRisk: input.pathAccess.audit.pathRisk,
    workspaceScopeId: input.pathAccess.audit.workspaceScopeId,
    grantId: input.pathAccess.audit.grantId,
  });
  ctx.workspaceGrantStore?.recordAccess({
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    taskId: ctx.taskId,
    toolCallId: input.toolCallId,
    toolName: input.action.tool,
    operation: input.pathAccess.decision.requiredPermission,
    normalizedPath: input.pathAccess.decision.normalizedPath,
    matchedRoot: input.pathAccess.audit.matchedRoot,
    workspaceScopeId: input.pathAccess.audit.workspaceScopeId,
    grantId: input.pathAccess.audit.grantId,
    permissionSource: input.pathAccess.audit.permissionSource,
    decision: input.pathAccess.decision.allowed
      ? "allowed"
      : input.pathAccess.decision.needsConfirmation
        ? "needs_confirmation"
        : "denied",
    reason: input.pathAccess.decision.reason,
    crossWorkspace: input.pathAccess.audit.crossWorkspace,
    pathRisk: input.pathAccess.audit.pathRisk,
    pathRiskTier: input.pathAccess.audit.pathRiskTier,
  });
}

/** Agent 主循环工具实际执行：Timeline、路径审计、缓存、子 Agent 门控、write gate、PermissionGuard、registry 调用。 */
export async function runAgentToolAction(
  ctx: AgentToolActionRunContext,
  input: RunAgentToolActionInput,
): Promise<AgentToolActionRunResult> {
  const { action, iteration, toolCallId } = input;
  const base: AgentToolStep = {
    iteration,
    toolCallId,
    tool: action.tool,
    input: action.input ?? {},
    thought: action.thought,
    ok: false,
  };

  const tool = ctx.registry.get(action.tool);
  const activityRunId = ctx.runId ?? ctx.timeline?.getRun()?.id ?? "";
  const activity = new AgentToolActivityTracker(ctx.timeline, activityRunId);
  const inputRecord = (action.input ?? {}) as Record<string, unknown>;

  if (!tool) {
    activity.startTool({ tool: action.tool, toolInput: inputRecord, iteration, toolCallId });
    activity.fail(`未知工具：${action.tool}`);
    return { step: { ...base, error: `未知工具：${action.tool}` } };
  }

  activity.startTool({ tool: action.tool, toolInput: inputRecord, iteration, toolCallId });
  if (!ctx.isToolExposed(action.tool)) {
    const err = `工具「${action.tool}」仅主 Agent 可用，当前上下文不可调用。`;
    activity.fail(err);
    return { step: { ...base, permission: tool.permission, error: err } };
  }

  const withPermission = { ...base, permission: tool.permission };
  const pathAccess = ctx.preparePathAccess(action);
  if (pathAccess) {
    recordPathAccessAudit(ctx, { action, toolCallId, pathAccess });
  }
  if (pathAccess && !pathAccess.decision.allowed) {
    const step = ctx.buildPathBlockedStep(action, iteration, pathAccess, toolCallId);
    activity.fail(step.error ?? "路径策略拒绝访问", {
      outcomeKind: step.outcomeKind,
      workspaceAccess: pathAccess.audit,
    });
    ctx.failedActionMemory.record(step);
    return { step };
  }

  const cacheInputRecord = pathAccess?.grantVersionKey
    ? { ...inputRecord, _workspaceGrantVersion: pathAccess.grantVersionKey }
    : inputRecord;
  if (!input.isRecovery) {
    const cached = ctx.toolResultCache.lookup(action.tool, cacheInputRecord);
    if (cached) {
      activity.ok("复用本 run 缓存结果");
      return {
        step: buildCachedToolStep(ctx, withPermission, tool, cached.entry.output),
      };
    }
  }

  const subagentDispatchGuard = assessSubagentDispatchGuard(action, input.steps);
  if (subagentDispatchGuard) {
    activity.fail(subagentDispatchGuard);
    return { step: { ...withPermission, blocked: true, error: subagentDispatchGuard } };
  }

  const subagentSideEffectGuard = assessSubagentSideEffectGuard({
    action,
    allowedPermissions: ctx.allowedPermissions,
    permissionPolicy: ctx.permissionPolicy,
  });
  if (subagentSideEffectGuard) {
    activity.fail(subagentSideEffectGuard);
    return { step: { ...withPermission, blocked: true, error: subagentSideEffectGuard } };
  }

  const failedActionAssessment = ctx.failedActionMemory.assess(action);
  if (failedActionAssessment) {
    activity.fail(failedActionAssessment.reason);
    const blockedStep: AgentToolStep = {
      ...withPermission,
      blocked: true,
      executed: false,
      recoveryCircuitOpen: failedActionAssessment.circuitOpen,
      error: failedActionAssessment.reason,
    };
    ctx.failedActionMemory.record(blockedStep);
    return { step: blockedStep };
  }

  const writeOrchestration = ctx.workflowWriteOrchestration({
    tool: action.tool,
    steps: input.steps,
    goal: input.goal,
  });
  if (writeOrchestration.writePhaseBlocked) {
    const reason = writeOrchestration.blockedReason ?? "workflow write gate blocked";
    activity.fail(reason);
    return {
      step: {
        ...withPermission,
        blocked: true,
        workflowPhaseBlocked: true,
        error: reason,
      },
      workflowWrite: writeOrchestration,
    };
  }

  const permissionDecision = evaluatePermissionGuard({
    intent: ctx.getIntent(),
    permissionPolicy: ctx.permissionPolicy,
    toolName: tool.name,
    permission: tool.permission,
    input: action.input ?? {},
    allowedPermissions: ctx.allowedPermissions,
    scopedGrants: ctx.resolveScopedGrants(),
    shellPolicy: ctx.shellPolicy,
    networkPolicy: ctx.networkPolicy,
  });

  if (permissionDecision.decision === "deny") {
    const err = permissionDecision.reason ?? permissionDecision.risk.reasons[0] ?? "权限拒绝";
    activity.fail(err);
    return {
      step: {
        ...withPermission,
        blocked: true,
        error: err,
        risk: permissionDecision.risk,
        confirmationRequest: permissionDecision.confirmationRequest,
      },
      workflowWrite: writeOrchestration,
    };
  }

  if (permissionDecision.decision === "needsConfirmation") {
    const err =
      permissionDecision.reason ??
      `工具「${tool.name}」需要确认（权限 ${tool.permission}）。未开启自动确认，已跳过。`;
    activity.fail(err);
    return {
      step: {
        ...withPermission,
        blocked: true,
        error: err,
        risk: permissionDecision.risk,
        confirmationRequest: permissionDecision.confirmationRequest,
      },
      workflowWrite: writeOrchestration,
    };
  }

  ctx.trace?.write({
    type: "agent_tool",
    tool: action.tool,
    iteration,
    toolCallId,
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    taskId: ctx.taskId,
    workspaceAccess: pathAccess?.audit,
  });

  const result = await ctx.toolGateway.invokeRegistry({
    toolName: action.tool,
    input: pathAccess?.input ?? inputRecord,
    source: "agent_loop",
    budgetBucket: input.isRecovery ? "recovery" : input.isPreflight ? "preflight" : "main",
    workspaceRoot: pathAccess?.workspaceRoot ?? ctx.workspaceRoot,
    allowedPermissions: ctx.allowedPermissions,
    scopedGrants: ctx.resolveScopedGrants(),
    workspaceGrantStore: ctx.workspaceGrantStore,
    workspaceConfigScopes: ctx.workspaceConfigScopes,
    toolCallId,
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    requestId: ctx.requestId ?? ctx.runId,
    signal: ctx.signal,
    registryExtras: {
      sensitive: ctx.sensitive,
      subAgentDispatchDepth: ctx.subAgentDispatchDepth ?? 0,
      maxSubAgentDispatchDepth: ctx.maxSubAgentDispatchDepth ?? 1,
      projectAllowedPermissions: ctx.projectAllowedPermissions,
      parentAgentIntent: ctx.getIntent(),
      parentAgentWorkflowType: ctx.reconciledWorkflowType ?? ctx.policyWorkflowType,
    },
  });

  if (result.executed) {
    const layers = buildToolResultLayers(action.tool, result.output, {
      compact: ctx.contextManager
        ? (t, out) => ctx.contextManager!.compactToolOutput(t, out)
        : undefined,
    });
    const outcome: ToolOutcome = {
      class: result.outcomeClass,
      kind: result.outcomeKind as ToolOutcome["kind"],
      message: result.message,
      recoverable: result.recoverable,
      path: result.outcomePath,
      command: result.outcomeCommand,
      exitCode: result.outcomeExitCode,
      suggestedNextActions: result.suggestedNextActions,
    };
    ctx.trace?.write({
      type: "agent_tool",
      tool: action.tool,
      iteration,
      toolCallId,
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      taskId: ctx.taskId,
      status: traceStatusForOutcome(result.outcomeClass),
      outcomeClass: result.outcomeClass,
      outcomeKind: result.outcomeKind,
      rawJsonLength: layers.rawJsonLength,
      modelJsonLength: layers.modelJsonLength,
      userDisplay: layers.userDisplay,
      rawOutput: layers.raw,
      workspaceAccess: pathAccess?.audit,
    });
    const rawPath = action.input?.path;
    const path = typeof rawPath === "string" ? rawPath : undefined;
    const summary = layers.userDisplay.summary.slice(0, 200) || result.message;
    if (result.outcomeClass === "observation_failure") {
      activity.observe(summary, {
        durationMs: result.durationMs,
        outcomeKind: result.outcomeKind,
        exitCode: result.outcomeExitCode,
        command: result.outcomeCommand,
        workspaceAccess: pathAccess?.audit,
      });
    } else if (result.outcomeClass === "execution_error") {
      activity.fail(summary, {
        durationMs: result.durationMs,
        outcomeKind: result.outcomeKind,
        workspaceAccess: pathAccess?.audit,
      });
    } else {
      activity.ok(summary, {
        durationMs: result.durationMs,
        changedFiles: path ? [path] : undefined,
        workspaceAccess: pathAccess?.audit,
      });
    }
    const step = applyOutcomeToStep(withPermission, outcome, {
      executed: true,
      output: layers.modelVisible,
      resultLayers: layers,
      durationMs: result.durationMs,
      toolCallId: result.toolCallId,
      risk: result.risk,
      workspaceAccess: pathAccess?.audit,
    });
    if (!input.isRecovery && result.output !== undefined) {
      ctx.toolResultCache.store(action.tool, cacheInputRecord, result.output);
    }
    ctx.failedActionMemory.record(step);
    return { step, workflowWrite: writeOrchestration };
  }

  const errMsg = result.error ?? result.message;
  activity.fail(errMsg, { durationMs: result.durationMs, outcomeKind: result.outcomeKind });
  const failedStep = applyOutcomeToStep(
    withPermission,
    {
      class: "execution_error",
      kind: result.outcomeKind as ToolOutcome["kind"],
      message: errMsg,
      recoverable: false,
    },
    {
      executed: false,
      durationMs: result.durationMs,
      toolCallId: result.toolCallId,
      risk: result.risk,
      workspaceAccess: pathAccess?.audit,
    },
  );
  ctx.failedActionMemory.record(failedStep);
  return { step: failedStep, workflowWrite: writeOrchestration };
}
