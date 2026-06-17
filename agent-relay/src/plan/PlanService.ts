import { randomUUID } from "node:crypto";

import type { Planner } from "../agent/Planner.js";
import { finalizePlan } from "../agent/taskGraph.js";
import { PlanSchema, type Plan } from "../agent/types.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import { PlanCompiler } from "./PlanCompiler.js";
import { bindPlanTools } from "./planToolBinder.js";
import { PlanApprovalManager } from "./PlanApprovalManager.js";
import { buildRenderedPreviews, renderPublicPlanJson } from "./PlanRenderer.js";
import { PlanStore } from "./PlanStore.js";
import { PlanValidator, canTransition } from "./PlanValidator.js";
import { internalPlanFromLegacy } from "./planConverter.js";
import {
  PlanValidationError,
  PublicPlanJsonSchema,
  rejectExecutablePreview,
  type InternalTaskPlan,
  type PlanMode,
  type PlanStatus,
  type PublicPlanJson,
  type UserVisiblePlan,
} from "./types.js";

export interface PlanServiceOptions {
  workspaceRoot: string;
  store: PlanStore;
  validator: PlanValidator;
  approval: PlanApprovalManager;
  registry: ToolRegistry;
  trace?: TraceLogger;
}

export class PlanService {
  private readonly compiler = new PlanCompiler();

  constructor(private readonly options: PlanServiceOptions) {}

  async createDraftFromPlanner(input: {
    goal: string;
    context?: string;
    sessionId?: string;
    requestId?: string;
    mode?: PlanMode;
    planner: Planner;
  }): Promise<{
    planId: string;
    version: number;
    status: string;
    planHash: string;
    previewMarkdown: string;
    publicPlanJson: PublicPlanJson;
  }> {
    const legacy = await input.planner.generatePlan(input.goal, input.context);
    return this.persistLegacyAsDraft(bindPlanTools(legacy, { registry: this.options.registry }), {
      sessionId: input.sessionId,
      requestId: input.requestId,
      mode: input.mode,
      originType: "planner",
    });
  }

  persistLegacyAsDraft(
    legacy: Plan,
    meta: {
      sessionId?: string;
      requestId?: string;
      mode?: PlanMode;
      originType?: InternalTaskPlan["origin"]["type"];
      planId?: string;
      version?: number;
    },
  ): {
    planId: string;
    version: number;
    status: string;
    planHash: string;
    previewMarkdown: string;
    publicPlanJson: PublicPlanJson;
  } {
    const finalized = finalizePlan(legacy);
    const planId = meta.planId ?? randomUUID();
    const version = meta.version ?? 1;
    const draft = internalPlanFromLegacy(finalized, {
      planId,
      version,
      workspaceRoot: this.options.workspaceRoot,
      sessionId: meta.sessionId,
      requestId: meta.requestId,
      mode: meta.mode,
      originType: meta.originType,
      status: "draft",
    });
    const validated = this.options.validator.validate(draft);
    const awaiting: InternalTaskPlan = { ...validated, status: "awaiting_approval" };
    const saved = this.options.store.save(awaiting, "planner_draft");
    const previews = buildRenderedPreviews(saved.internal);
    this.logPlanEvent("plan.created", saved.planId, saved.version);
    this.logPlanEvent("plan.validated", saved.planId, saved.version);
    this.logPlanEvent("plan.preview_rendered", saved.planId, saved.version);
    return {
      planId: saved.planId,
      version: saved.version,
      status: saved.status,
      planHash: saved.planHash,
      previewMarkdown: previews.markdown.content,
      publicPlanJson: renderPublicPlanJson(saved.internal),
    };
  }

  ingestLegacyPlanBody(planBody: unknown, dryRunOnly: boolean): ReturnType<PlanService["persistLegacyAsDraft"]> {
    rejectExecutablePreview(planBody);
    const publicParsed = PublicPlanJsonSchema.safeParse(planBody);
    if (publicParsed.success) {
      throw new PlanValidationError(
        "EXECUTABLE_PREVIEW_REJECTED",
        "PublicPlanJson 不能导入为可执行计划，请提供目标由 Planner 重新生成",
      );
    }
    const parsed = PlanSchema.safeParse(planBody);
    if (!parsed.success) {
      throw new PlanValidationError("INVALID_SCHEMA", `计划格式不合法：${parsed.error.message}`);
    }
    if (!dryRunOnly) {
      throw new PlanValidationError(
        "PLAN_NOT_APPROVED",
        "生产执行不接受 body 中的 plan JSON，请使用 planId + version",
      );
    }
    return this.persistLegacyAsDraft(bindPlanTools(parsed.data, { registry: this.options.registry }), {
      originType: "legacy_ingest",
    });
  }

  async importPreviewAsRevision(input: {
    preview: unknown;
    goal?: string;
    sessionId?: string;
    planId?: string;
    baseVersion?: number;
    planner: Planner;
  }): Promise<{
    planId: string;
    version: number;
    status: string;
    previewMarkdown: string;
    publicPlanJson: PublicPlanJson;
    supersededVersion?: number;
  }> {
    rejectExecutablePreview(input.preview);
    const parsed = PublicPlanJsonSchema.safeParse(input.preview);
    const context = parsed.success
      ? `用户导入的展示计划（不可执行）：${JSON.stringify(parsed.data)}`
      : typeof input.preview === "string"
        ? input.preview
        : JSON.stringify(input.preview);
    const goal =
      input.goal?.trim() ||
      (parsed.success ? parsed.data.title : "") ||
      "根据用户导入内容修订计划";

    if (input.planId) {
      const baseVersion = input.baseVersion ?? this.options.store.getLatestVersion(input.planId);
      if (!baseVersion) {
        throw new PlanValidationError("INVALID_SCHEMA", "计划不存在");
      }
      return this.createInternalRevision({
        planId: input.planId,
        baseVersion,
        goal,
        context,
        sessionId: input.sessionId,
        planner: input.planner,
        originType: "import_preview",
      });
    }

    const legacy = await input.planner.generatePlan(goal, context);
    return this.persistLegacyAsDraft(bindPlanTools(legacy, { registry: this.options.registry }), {
      sessionId: input.sessionId,
      originType: "import_preview",
    });
  }

  async revisePlan(input: {
    planId: string;
    baseVersion?: number;
    revisionRequest: string;
    sessionId?: string;
    planner: Planner;
  }): Promise<{
    planId: string;
    version: number;
    status: string;
    planHash: string;
    previewMarkdown: string;
    publicPlanJson: PublicPlanJson;
    supersededVersion: number;
  }> {
    const revisionRequest = input.revisionRequest.trim();
    if (!revisionRequest) {
      throw new PlanValidationError("INVALID_SCHEMA", "revisionRequest 不能为空");
    }
    const baseVersion = input.baseVersion ?? this.options.store.getLatestVersion(input.planId);
    if (!baseVersion) {
      throw new PlanValidationError("INVALID_SCHEMA", "计划不存在");
    }
    return this.createInternalRevision({
      planId: input.planId,
      baseVersion,
      goal: `修订计划 v${baseVersion}：${revisionRequest}`,
      context: revisionRequest,
      sessionId: input.sessionId,
      planner: input.planner,
      originType: "revision",
    });
  }

  async createInternalRevision(input: {
    planId: string;
    baseVersion: number;
    goal: string;
    context?: string;
    sessionId?: string;
    planner: Planner;
    originType?: InternalTaskPlan["origin"]["type"];
  }): Promise<{
    planId: string;
    version: number;
    status: string;
    planHash: string;
    previewMarkdown: string;
    publicPlanJson: PublicPlanJson;
    supersededVersion: number;
  }> {
    const base = this.options.store.get(input.planId, input.baseVersion);
    if (!base) {
      throw new PlanValidationError("INVALID_SCHEMA", "计划不存在");
    }
    if (base.status === "running") {
      throw new PlanValidationError("PLAN_NOT_APPROVED", "执行中的计划不可修订");
    }
    const nextVersion = input.baseVersion + 1;
    if (this.options.store.get(input.planId, nextVersion)) {
      throw new PlanValidationError("INVALID_SCHEMA", `版本 ${nextVersion} 已存在`);
    }

    if (canTransition(base.status, "superseded")) {
      this.options.store.updateStatus(input.planId, input.baseVersion, "superseded");
      this.logPlanEvent("plan.superseded", input.planId, input.baseVersion);
    }

    const markdown = this.getPreview(input.planId, input.baseVersion, "markdown");
    const contextParts = [
      input.context,
      markdown ? `上一版 Markdown 预览（v${input.baseVersion}，不可执行）：\n${markdown}` : undefined,
    ].filter((part): part is string => Boolean(part));

    const legacy = await input.planner.generatePlan(input.goal, contextParts.join("\n\n"));
    const bound = bindPlanTools(legacy, { registry: this.options.registry });
    const draft = this.persistLegacyAsDraft(bound, {
      planId: input.planId,
      version: nextVersion,
      sessionId: input.sessionId,
      originType: input.originType ?? "revision",
    });
    return { ...draft, supersededVersion: input.baseVersion };
  }

  getPlanSummary(planId: string): {
    planId: string;
    latestVersion: number;
    status: PlanStatus;
    goal: string;
    versions: ReturnType<PlanStore["listVersions"]>;
  } | null {
    const head = this.options.store.get(planId);
    if (!head) return null;
    return {
      planId,
      latestVersion: head.version,
      status: head.status,
      goal: head.goal,
      versions: this.options.store.listVersions(planId),
    };
  }

  approve(planId: string, version: number, approvedBy: string, comment?: string): InternalTaskPlan {
    const internal = this.options.approval.approve(planId, version, approvedBy, comment);
    this.logPlanEvent("plan.approved", planId, version, approvedBy);
    return internal;
  }

  reject(planId: string, version: number, approvedBy: string, comment?: string): InternalTaskPlan {
    const internal = this.options.approval.reject(planId, version, approvedBy, comment);
    this.logPlanEvent("plan.rejected", planId, version, approvedBy);
    return internal;
  }

  getRecord(planId: string, version: number) {
    return this.options.store.get(planId, version);
  }

  ensureApprovedForDryRun(planId: string, version: number): void {
    const record = this.options.store.get(planId, version);
    if (!record) throw new PlanValidationError("INVALID_SCHEMA", "计划不存在");
    if (record.status === "awaiting_approval" || record.status === "validated") {
      this.approve(planId, version, "system:dry-run", "auto before dry-run");
    }
  }

  createPlanRun(planId: string, version: number) {
    return this.options.store.createPlanRun({ planId, version, status: "running" });
  }

  loadExecutable(planId: string, version: number): InternalTaskPlan {
    const record = this.options.store.get(planId, version);
    if (!record) {
      throw new PlanValidationError("INVALID_SCHEMA", "计划不存在");
    }
    this.options.validator.assertExecutable(record.internal, record.planHash);
    return record.internal;
  }

  markRunning(planId: string, version: number): InternalTaskPlan {
    const updated = this.options.store.updateStatus(planId, version, "running");
    if (!updated) throw new Error("更新 running 失败");
    this.logPlanEvent("plan.execution_started", planId, version);
    return updated.internal;
  }

  markCompleted(planId: string, version: number, success: boolean): void {
    const status = success ? "completed" : "failed";
    this.options.store.updateStatus(planId, version, status);
    this.logPlanEvent(success ? "plan.execution_completed" : "plan.execution_failed", planId, version);
  }

  getPreview(planId: string, version: number, format: "markdown" | "json"): string | null {
    const preview = this.options.store.getPreview(planId, version, format);
    return preview?.content ?? null;
  }

  saveUserVisiblePlan(plan: UserVisiblePlan): UserVisiblePlan {
    const saved = this.options.store.saveUserVisiblePlan(plan);
    this.options.trace?.write({
      type: "plan_event",
      eventType: "user_visible_plan.created",
      userVisiblePlanId: saved.id,
      sourceRunId: saved.sourceRunId,
      at: new Date().toISOString(),
    });
    return saved;
  }

  getUserVisiblePlan(id: string): UserVisiblePlan | null {
    return this.options.store.getUserVisiblePlan(id);
  }

  getLatestUserVisiblePlanForSession(sessionId: string): UserVisiblePlan | null {
    return this.options.store.getLatestUserVisiblePlanForSession(sessionId);
  }

  recordPlanRunStepStarted(input: {
    planRunId: string;
    stepId: string;
    toolName?: string;
  }): string {
    const rowId = this.options.store.createPlanRunStep({
      planRunId: input.planRunId,
      stepId: input.stepId,
      status: "running",
      toolName: input.toolName,
    });
    this.options.trace?.write({
      type: "plan_event",
      eventType: "plan.step_started",
      planRunId: input.planRunId,
      stepId: input.stepId,
      toolName: input.toolName,
      at: new Date().toISOString(),
    });
    return rowId;
  }

  recordPlanRunStepFinished(
    stepRowId: string,
    input: { status: string; error?: string; outputPreview?: string; planRunId?: string; stepId?: string },
  ): void {
    this.options.store.finishPlanRunStep(stepRowId, input);
    this.options.trace?.write({
      type: "plan_event",
      eventType:
        input.status === "completed" ? "plan.step_completed" : "plan.step_failed",
      planRunId: input.planRunId,
      stepId: input.stepId,
      status: input.status,
      error: input.error,
      at: new Date().toISOString(),
    });
  }

  async compileUserVisiblePlan(input: {
    userVisiblePlanId: string;
    confirmedTodoIds: string[];
    sessionId?: string;
    requestId?: string;
    planner?: Planner;
  }): Promise<
    ReturnType<PlanService["persistLegacyAsDraft"]> & { sourceUserVisiblePlan: UserVisiblePlan }
  > {
    const userVisiblePlan = this.getUserVisiblePlan(input.userVisiblePlanId);
    if (!userVisiblePlan) {
      throw new PlanValidationError("INVALID_SCHEMA", "UserVisiblePlan 不存在");
    }
    const skeleton = this.compiler.compile({
      userVisiblePlan,
      confirmedTodoIds: input.confirmedTodoIds,
    });
    const executable = await this.resolveExecutablePlan({
      skeleton,
      userVisiblePlan,
      planner: input.planner,
    });
    const draft = this.persistLegacyAsDraft(executable, {
      sessionId: input.sessionId ?? userVisiblePlan.sessionId,
      requestId: input.requestId ?? userVisiblePlan.sourceRunId,
      mode: "implement",
      originType: "user_visible_plan",
    });
    this.options.trace?.write({
      type: "plan_event",
      eventType: "user_visible_plan.compiled",
      userVisiblePlanId: userVisiblePlan.id,
      planId: draft.planId,
      version: draft.version,
      at: new Date().toISOString(),
    });
    return { ...draft, sourceUserVisiblePlan: userVisiblePlan };
  }

  private async resolveExecutablePlan(input: {
    skeleton: Plan;
    userVisiblePlan: UserVisiblePlan;
    planner?: Planner;
  }): Promise<Plan> {
    const context = JSON.stringify({
      userVisiblePlanId: input.userVisiblePlan.id,
      title: input.userVisiblePlan.title,
      skeleton: input.skeleton,
    });
    let plan = input.skeleton;
    if (input.planner) {
      try {
        plan = await input.planner.generateExecutablePlan(input.skeleton.goal, context);
      } catch {
        plan = input.skeleton;
      }
    }
    const bound = bindPlanTools(plan, { registry: this.options.registry });
    const internalPreview = internalPlanFromLegacy(bound, {
      planId: "compile-preview",
      version: 1,
      workspaceRoot: this.options.workspaceRoot,
      originType: "user_visible_plan",
    });
    this.options.validator.assertToolBindings(internalPreview);
    return bound;
  }

  rejectExecutionBody(body: Record<string, unknown>): { error: string; code: string } | null {
    if ("internalPlan" in body && body.internalPlan !== undefined) {
      return {
        code: "INTERNAL_PLAN_BODY_REJECTED",
        error: "执行 API 不接受 internalPlan 字段，仅接受 planId + version",
      };
    }
    if ("plan" in body && body.plan !== undefined && !body.planId) {
      return null;
    }
    return null;
  }

  private logPlanEvent(
    eventType: string,
    planId: string,
    version: number,
    actor = "agent",
  ): void {
    this.options.trace?.write({
      type: "plan_event",
      eventType,
      planId,
      version,
      actor,
      at: new Date().toISOString(),
    });
  }
}
