import type { ToolPermission } from "../core/permissions.js";
import { evaluatePermissionGuard } from "../policy/PermissionGuard.js";
import type { ScopedApprovedPermissions } from "../policy/permissionRequestTypes.js";
import { PathPolicy, type ToolPathPreparation } from "../policy/PathPolicy.js";
import type { WorkspaceGrantStore, WorkspaceScopePermission } from "../policy/WorkspaceScopeManager.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { RegistryRunContext } from "../tools/ToolRegistry.js";
import type { ToolRunResult } from "../tools/types.js";
import type { BudgetManager } from "./BudgetManager.js";
import type { AgentIntentType } from "./IntentTypes.js";
import type { AgentRunMode, RunBudgetKey, UserPermissionPolicy } from "./RunPolicyTypes.js";
import type { AgentToolStep } from "./toolStep.js";
import {
  assessWorkflowToolAccess,
  type WorkflowCapabilityAssessment,
} from "./WorkflowCapability.js";
import type { WorkflowRouteResult } from "./WorkflowRouter.js";
import { defaultWorkflowRouter } from "./WorkflowRouter.js";

export type ToolExecutionSource =
  | "agent_loop"
  | "resume"
  | "preflight"
  | "task_runner"
  | "manual"
  | "rollback";

export type BudgetBucket =
  | "main"
  | "preflight"
  | "recovery"
  | "resume"
  | "manual"
  | "rollback";

export interface ToolExecutionContext {
  workspaceRoot: string;
  sessionId?: string;
  taskId?: string;
  requestId?: string;
  signal?: AbortSignal;
  allowedPermissions: ToolPermission[];
  intent?: AgentIntentType;
  permissionPolicy?: UserPermissionPolicy;
  mode?: AgentRunMode;
  workflowRoute?: Pick<
    WorkflowRouteResult,
    "workflowKind" | "readonlyOnly" | "enforceReadOnlyTools" | "sideEffectKind"
  >;
  scopedGrants?: ScopedApprovedPermissions;
  workspaceGrantStore?: WorkspaceGrantStore;
  workspaceConfigScopes?: Array<{
    id: string;
    rootPath: string;
    label?: string;
    permissions?: WorkspaceScopePermission[];
  }>;
  budgetManager?: BudgetManager;
  existingSteps?: AgentToolStep[];
  isRecovery?: boolean;
  isPreflight?: boolean;
  skipWorkflowCheck?: boolean;
  skipPermissionCheck?: boolean;
  skipBudgetCheck?: boolean;
  shellPolicy?: import("../policy/ShellPolicy.js").ShellPolicy;
  networkPolicy?: import("../policy/NetworkPolicy.js").NetworkPolicy;
}

export interface ToolExecutionEvaluateInput extends ToolExecutionContext {
  toolName: string;
  input?: Record<string, unknown>;
  source: ToolExecutionSource;
  budgetBucket: BudgetBucket;
}

export interface ToolExecutionEvaluation {
  allowed: boolean;
  blocked: boolean;
  blockReasonKind?: "workflow" | "permission" | "budget" | "policy";
  workflowBlock?: WorkflowCapabilityAssessment;
  permissionDecision?: ReturnType<typeof evaluatePermissionGuard>;
  budgetExhausted?: RunBudgetKey;
  pathAccess?: ToolPathPreparation;
  reason?: string;
}

export interface ToolExecutionRunInput extends ToolExecutionEvaluateInput {
  toolCallId?: string;
  /** AgentLoop 等路径传入的 registry 扩展上下文。 */
  registryExtras?: Partial<RegistryRunContext>;
}

/**
 * 统一工具执行网关：workflow → PermissionGuard → Budget → ToolRegistry。
 * 业务层除单元测试外应经此网关调用工具，避免旁路绕过安全链。
 */
export class ToolExecutionGateway {
  constructor(private readonly registry: ToolRegistry) {}

  evaluate(input: ToolExecutionEvaluateInput): ToolExecutionEvaluation {
    const tool = this.registry.get(input.toolName);
    if (!tool) {
      return {
        allowed: false,
        blocked: true,
        blockReasonKind: "policy",
        reason: `未知工具：${input.toolName}`,
      };
    }

    const pathPolicy = new PathPolicy({
      primaryRoot: input.workspaceRoot,
      grants: input.workspaceGrantStore,
      configScopes: input.workspaceConfigScopes,
    });
    const pathAccess = pathPolicy.prepareTool(input.toolName, input.input ?? {}, {
      sessionId: input.sessionId,
      taskId: input.taskId,
      scopedGrants: input.scopedGrants,
    });
    if (pathAccess && !pathAccess.decision.allowed) {
      if (pathAccess.decision.needsConfirmation) {
        return {
          allowed: false,
          blocked: true,
          blockReasonKind: "permission",
          pathAccess,
          reason: `跨工作区访问需要用户授权：${pathAccess.decision.normalizedPath}`,
        };
      }
      if (!pathAccess.decision.needsConfirmation) {
        return {
          allowed: false,
          blocked: true,
          blockReasonKind: "permission",
          pathAccess,
          reason: `路径策略拒绝访问：${pathAccess.decision.reason}`,
        };
      }
    }

    if (!input.skipWorkflowCheck && input.workflowRoute && input.mode) {
      const workflowBlock = assessWorkflowToolAccess({
        mode: input.mode,
        workflowRoute: input.workflowRoute,
        toolPermission: tool.permission,
      });
      if (workflowBlock.blocked) {
        return {
          allowed: false,
          blocked: true,
          blockReasonKind: "workflow",
          workflowBlock,
          reason: workflowBlock.reason ?? "工作流不允许该工具权限",
        };
      }
    }

    if (!input.skipPermissionCheck && input.intent && input.permissionPolicy) {
      const permissionDecision = evaluatePermissionGuard({
        intent: input.intent,
        permissionPolicy: input.permissionPolicy,
        toolName: tool.name,
        permission: tool.permission,
        input: input.input ?? {},
        allowedPermissions: input.allowedPermissions,
        scopedGrants: input.scopedGrants,
        shellPolicy: input.shellPolicy,
        networkPolicy: input.networkPolicy,
      });
      if (permissionDecision.decision === "deny") {
        return {
          allowed: false,
          blocked: true,
          blockReasonKind: "permission",
          permissionDecision,
          reason: permissionDecision.reason ?? "权限拒绝",
        };
      }
      if (
        permissionDecision.decision === "needsConfirmation" &&
        input.source !== "agent_loop" &&
        input.source !== "resume"
      ) {
        return {
          allowed: false,
          blocked: true,
          blockReasonKind: "permission",
          permissionDecision,
          reason:
            permissionDecision.reason ??
            `工具「${tool.name}」需要用户确认，${input.source} 路径不会自动执行`,
        };
      }
    }

    if (!input.skipBudgetCheck && input.budgetManager) {
      const budgetExhausted = input.budgetManager.findToolExhaustion({
        toolPermission: tool.permission,
        permissionAllowed: input.allowedPermissions.includes(tool.permission),
        steps: input.existingSteps ?? [],
        isRecovery: input.isRecovery ?? input.budgetBucket === "recovery",
        isPreflight: input.isPreflight ?? input.budgetBucket === "preflight",
      });
      if (budgetExhausted) {
        return {
          allowed: false,
          blocked: true,
          blockReasonKind: "budget",
          budgetExhausted,
          reason: `运行预算已耗尽：${budgetExhausted}`,
        };
      }
    }

    return { allowed: true, blocked: false, pathAccess };
  }

  async run(input: ToolExecutionRunInput): Promise<ToolRunResult> {
    const evaluation = this.evaluate(input);
    if (evaluation.blocked) {
      return blockedToolRunResult(input.toolName, evaluation);
    }

    if (input.budgetManager) {
      if (input.budgetBucket === "preflight" || input.isPreflight) {
        input.budgetManager.recordPreflightTool();
      } else if (input.budgetBucket === "recovery" || input.isRecovery) {
        input.budgetManager.recordRecoveryTurn();
      }
    }

    const pathAccess = evaluation.pathAccess;
      return this.registry.run(input.toolName, pathAccess?.input ?? input.input ?? {}, {
        workspaceRoot: pathAccess?.workspaceRoot ?? input.workspaceRoot,
      taskId: input.taskId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      toolCallId: input.toolCallId,
        signal: input.signal,
        allowedPermissions: input.allowedPermissions,
        workspaceAccess: pathAccess?.audit as unknown as Record<string, unknown> | undefined,
        ...input.registryExtras,
      });
  }

  /** AgentLoop 已通过 executeToolStep 完成门禁后，仅经网关调用 registry。 */
  async invokeRegistry(input: ToolExecutionRunInput): Promise<ToolRunResult> {
    const pathPolicy = new PathPolicy({
      primaryRoot: input.workspaceRoot,
      grants: input.workspaceGrantStore,
      configScopes: input.workspaceConfigScopes,
    });
    const pathAccess = pathPolicy.prepareTool(input.toolName, input.input ?? {}, {
      sessionId: input.sessionId,
      taskId: input.taskId,
      scopedGrants: input.scopedGrants,
    });
    if (pathAccess && !pathAccess.decision.allowed) {
      return blockedToolRunResult(input.toolName, {
        allowed: false,
        blocked: true,
        blockReasonKind: "permission",
        pathAccess,
        reason: pathAccess.decision.needsConfirmation
          ? `跨工作区访问需要用户授权：${pathAccess.decision.normalizedPath}`
          : `路径策略拒绝访问：${pathAccess.decision.reason}`,
      });
    }
    return this.registry.run(input.toolName, pathAccess?.input ?? input.input ?? {}, {
      workspaceRoot: pathAccess?.workspaceRoot ?? input.workspaceRoot,
      taskId: input.taskId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      toolCallId: input.toolCallId,
      signal: input.signal,
      allowedPermissions: input.allowedPermissions,
      workspaceAccess: pathAccess?.audit as unknown as Record<string, unknown> | undefined,
      ...input.registryExtras,
    });
  }
}

export function defaultWorkflowRouteForTaskTool(
  toolPermission?: ToolPermission,
): Pick<WorkflowRouteResult, "workflowKind" | "readonlyOnly" | "enforceReadOnlyTools" | "sideEffectKind"> {
  if (toolPermission === "shell") {
    return defaultWorkflowRouter.routeIntent("run");
  }
  if (toolPermission === "write" || toolPermission === "dangerous") {
    return defaultWorkflowRouter.routeIntent("edit");
  }
  return defaultWorkflowRouter.routeIntent("answer");
}

function blockedToolRunResult(tool: string, evaluation: ToolExecutionEvaluation): ToolRunResult {
  const isPermission = evaluation.blockReasonKind === "permission";
  const needsPathConfirmation = evaluation.pathAccess?.decision.needsConfirmation === true;
  return {
    tool,
    durationMs: 0,
    executed: false,
    outcomeClass: "execution_error",
    outcomeKind: isPermission ? "permission_denied" : evaluation.blockReasonKind ?? "blocked",
    message: evaluation.reason ?? "工具执行被阻止",
    recoverable: evaluation.blockReasonKind === "budget" || needsPathConfirmation,
    requiresUserAction: needsPathConfirmation,
    ok: false,
    code: isPermission ? "permission_denied" : undefined,
    category: isPermission ? "permission_error" : "user_error",
    error: evaluation.reason,
    risk: evaluation.permissionDecision?.risk,
  };
}
