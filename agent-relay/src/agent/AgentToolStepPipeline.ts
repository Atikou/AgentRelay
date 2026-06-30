import type { ToolPermission } from "../core/permissions.js";
import type { ChatMessage } from "../model/types.js";
import { evaluatePermissionGuard } from "../policy/PermissionGuard.js";
import type { NetworkPolicy } from "../policy/NetworkPolicy.js";
import type { ShellPolicy } from "../policy/ShellPolicy.js";
import type { ToolPathPreparation } from "../policy/PathPolicy.js";
import type { ScopedApprovedPermissions } from "../policy/permissionRequestTypes.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolAction } from "./AgentActionParser.js";
import {
  reconcileCapabilityBeforeTool as applyCapabilityEscalationBeforeTool,
  type CapabilityEscalationTimelineSink,
  type ReconcileCapabilityBeforeToolResult,
} from "./AgentCapabilityEscalationOrchestrator.js";
import type { CapabilityEscalationRecord } from "./CapabilityEscalation.js";
import type { BudgetManager } from "./BudgetManager.js";
import { effectiveWorkflowRoute, type EffectiveWorkflowContext } from "./EffectiveWorkflowContext.js";
import type { AgentIntentType } from "./IntentTypes.js";
import type { AgentRunMode, RunBudgetKey, UserPermissionPolicy } from "./RunPolicyTypes.js";
import type { AgentToolStep } from "./toolStep.js";
import {
  buildBudgetBlockedToolStep,
  buildPathBlockedToolStep,
  buildPermissionBlockedToolStep,
  buildWorkflowBlockedToolStep,
} from "./AgentToolStepBlockBuilder.js";
import { assessWorkflowToolAccess } from "./WorkflowCapability.js";

export type AgentToolStepPipelineResult =
  | { kind: "step"; step: AgentToolStep }
  | {
      kind: "pause";
      step: AgentToolStep;
      pauseSteps: AgentToolStep[];
    }
  | {
      kind: "budget";
      step: AgentToolStep;
      budgetExhausted: RunBudgetKey;
    };

export interface AgentToolStepPipelineContext {
  registry: ToolRegistry;
  mode: AgentRunMode;
  permissionPolicy: UserPermissionPolicy;
  allowedPermissions: ToolPermission[];
  getIntent: () => AgentIntentType;
  getWorkflowContext: () => EffectiveWorkflowContext;
  capabilityEscalations: CapabilityEscalationRecord[];
  budgetManager: BudgetManager;
  shellPolicy?: ShellPolicy;
  networkPolicy?: NetworkPolicy;
  timeline?: CapabilityEscalationTimelineSink;
  runId?: string;
  pauseOnPermissionRequest: boolean;
  resolveScopedGrants: () => ScopedApprovedPermissions | undefined;
  preparePathAccess: (action: ToolAction) => ToolPathPreparation | undefined;
  runToolAction: (
    action: ToolAction,
    iteration: number,
    toolCallId: string,
    ctx: { steps: AgentToolStep[]; goal: string },
  ) => Promise<AgentToolStep>;
  onCapabilityReconciled?: (result: ReconcileCapabilityBeforeToolResult) => void;
}

export interface ExecuteAgentToolStepInput {
  action: ToolAction;
  iteration: number;
  toolCallId: string;
  steps: AgentToolStep[];
  goal: string;
  messages: ChatMessage[];
  skipJitPause?: boolean;
}

/**
 * Agent 主循环统一工具执行管道：escalation → WorkflowCapability → PermissionGuard → path → Budget → runToolAction。
 * JIT 暂停与 budget 收尾由 AgentLoop 根据返回 kind 处理。
 */
export async function executeAgentToolStepPipeline(
  ctx: AgentToolStepPipelineContext,
  input: ExecuteAgentToolStepInput,
): Promise<AgentToolStepPipelineResult> {
  const tool = ctx.registry.get(input.action.tool);
  const workflowRoute = effectiveWorkflowRoute(ctx.getWorkflowContext());
  const escalationResult = applyCapabilityEscalationBeforeTool({
    action: input.action,
    toolPermission: tool?.permission,
    workflowRoute,
    iteration: input.iteration,
    messages: input.messages,
    capabilityEscalations: ctx.capabilityEscalations,
    budgetManager: ctx.budgetManager,
    permissionPolicy: ctx.permissionPolicy,
    timeline: ctx.timeline,
    runId: ctx.runId,
  });
  ctx.onCapabilityReconciled?.(escalationResult);

  const workflowBlock = assessWorkflowToolAccess({
    mode: ctx.mode,
    workflowRoute,
    toolPermission: tool?.permission,
  });
  if (workflowBlock.blocked) {
    return {
      kind: "step",
      step: buildWorkflowBlockedToolStep({
        action: input.action,
        iteration: input.iteration,
        toolCallId: input.toolCallId,
        toolPermission: tool?.permission,
        block: workflowBlock,
      }),
    };
  }

  if (tool) {
    const permissionDecision = evaluatePermissionGuard({
      intent: ctx.getIntent(),
      permissionPolicy: ctx.permissionPolicy,
      toolName: tool.name,
      permission: tool.permission,
      input: input.action.input ?? {},
      allowedPermissions: ctx.allowedPermissions,
      scopedGrants: ctx.resolveScopedGrants(),
      shellPolicy: ctx.shellPolicy,
      networkPolicy: ctx.networkPolicy,
    });
    if (permissionDecision.decision === "deny") {
      return {
        kind: "step",
        step: buildPermissionBlockedToolStep({
          action: input.action,
          iteration: input.iteration,
          toolCallId: input.toolCallId,
          toolPermission: tool.permission,
          reason: permissionDecision.reason ?? "权限拒绝",
        }),
      };
    }
    if (permissionDecision.decision === "needsConfirmation" && !input.skipJitPause) {
      const step = await ctx.runToolAction(input.action, input.iteration, input.toolCallId, {
        steps: input.steps,
        goal: input.goal,
      });
      if (
        step.blocked &&
        step.confirmationRequest?.status === "waiting_confirmation" &&
        ctx.pauseOnPermissionRequest
      ) {
        return { kind: "pause", step, pauseSteps: input.steps };
      }
      return { kind: "step", step };
    }
  }

  const pathAccess = ctx.preparePathAccess(input.action);
  if (pathAccess && !pathAccess.decision.allowed) {
    const step = buildPathBlockedToolStep({
      action: input.action,
      iteration: input.iteration,
      toolCallId: input.toolCallId,
      toolPermission: tool?.permission,
      pathAccess,
      intent: ctx.getIntent(),
      permissionPolicy: ctx.permissionPolicy,
    });
    if (
      pathAccess.decision.needsConfirmation &&
      !input.skipJitPause &&
      ctx.pauseOnPermissionRequest
    ) {
      return { kind: "pause", step, pauseSteps: [...input.steps, step] };
    }
    return { kind: "step", step };
  }

  const toolBudgetExhausted = ctx.budgetManager.findToolExhaustion({
    toolPermission: tool?.permission,
    permissionAllowed: Boolean(tool),
    steps: input.steps,
  });
  if (toolBudgetExhausted) {
    return {
      kind: "budget",
      step: buildBudgetBlockedToolStep({
        action: input.action,
        iteration: input.iteration,
        toolCallId: input.toolCallId,
        toolPermission: tool?.permission,
        budgetExhausted: toolBudgetExhausted,
      }),
      budgetExhausted: toolBudgetExhausted,
    };
  }

  const step = await ctx.runToolAction(input.action, input.iteration, input.toolCallId, {
    steps: input.steps,
    goal: input.goal,
  });
  return { kind: "step", step };
}
