import path from "node:path";
import { fileURLToPath } from "node:url";

import { Planner } from "../agent/Planner.js";
import type { LoopChatFn } from "../agent/AgentLoop.js";
import type { ToolPermission } from "../core/permissions.js";
import { BackgroundTaskManager, NotificationQueue } from "../background/index.js";
import { loadConfig } from "../config/loadConfig.js";
import type { AppConfig } from "../config/types.js";
import { ContextManager } from "../context/index.js";
import { createModelClient } from "../model/ModelFactory.js";
import { MetricsRegistry } from "../model/MetricsRegistry.js";
import { createDirectChatFn, type ClientPricing } from "../model/directChat.js";
import type { ModelClient } from "../model/types.js";
import {
  PlanApprovalManager,
  PlanService,
  PlanStore,
  PlanValidator,
} from "../plan/index.js";
import { Orchestrator } from "../orchestrator/Orchestrator.js";
import { RunStore } from "../orchestrator/RunStore.js";
import { RunStateStore } from "../orchestrator/RunStateStore.js";
import { ProjectIndex } from "../context/ProjectIndex.js";
import { ProjectSemanticIndexer } from "../context/ProjectSemanticIndexer.js";
import { HistoryFileRecaller } from "../context/HistoryFileRecaller.js";
import { Scheduler } from "../scheduler/index.js";
import { SubAgentCoordinator } from "../subagent/index.js";
import { SubAgentRunRegistry } from "../subagent/SubAgentRunRegistry.js";
import {
  setSubagentDefaultTimeoutMs,
} from "../subagent/dispatchInputNormalize.js";
import { initSubAgentLocalQueueGate } from "../subagent/SubAgentLocalQueueGate.js";
import { AgentRunRegistry } from "../orchestrator/AgentRunRegistry.js";
import { createDefaultRegistry } from "../tools/index.js";
import { createShellPolicy, type ShellPolicy } from "../policy/ShellPolicy.js";
import { createNetworkPolicy, type NetworkPolicy } from "../policy/NetworkPolicy.js";
import { resolveProjectAllowedPermissions, PERMISSION_SCOPE_ORDER } from "../policy/PermissionPolicy.js";
import { ModelOrchestrator } from "../model-orchestrator/index.js";
import {
  buildModelProfiles,
  CollaborationRunStore,
  createModelChatFn,
  createAgentChatFn,
  createPlannerChatFn,
  createDelegatedTaskChatFn,
  ModelCallLogStore,
  ModelAvailabilityRegistry,
  ModelRegistry,
  ModelProfileStore,
  RouteLogStore,
  SmartModelRouter,
  RuntimeStatsFeedback,
  FallbackManager,
  FallbackLogStore,
  EvalSetRunner,
  ModelEvalStore,
  validateModelProfiles,
  validateCapabilityMatrixCoverage,
} from "../model-router/index.js";
import { recoverOnStartup, type StartupRecoverySummary } from "./startupRecovery.js";
import { TraceLogger, createSegmentedTraceLogger } from "../trace/TraceLogger.js";
import { loadLifecyclePolicy } from "../lifecycle/policy.js";
import type { TraceCatalog } from "../trace/traceCatalog.js";
import { DataLifecycleService } from "../lifecycle/DataLifecycleService.js";

export interface AppPaths {
  projectRoot: string;
  repoRoot: string;
  publicDir: string;
  docsDir: string;
  docsAssetsDir: string;
  dataDir: string;
  tracesDir: string;
  traceFile: string;
}

/** 应用级依赖容器：server / CLI / 测试共用。 */
export class AppContext {
  readonly profile: string;
  readonly config: AppConfig;
  readonly workspaceRoot: string;
  readonly paths: AppPaths;
  readonly clientMap: Map<string, ModelClient>;
  readonly metrics: MetricsRegistry;
  readonly trace: TraceLogger;
  readonly traceCatalog: TraceCatalog;
  readonly notificationQueue: NotificationQueue;
  readonly scheduler: Scheduler;
  readonly backgroundTasks: BackgroundTaskManager;
  readonly directChat: ReturnType<typeof createDirectChatFn>;
  readonly planner: Planner;
  readonly registry: ReturnType<typeof createDefaultRegistry>;
  readonly contextManager: ContextManager;
  readonly runs: RunStore;
  readonly runStateStore: RunStateStore;
  readonly projectIndex: ProjectIndex;
  readonly projectSemanticIndexer: ProjectSemanticIndexer;
  readonly historyFileRecaller: HistoryFileRecaller;
  readonly orchestrator: Orchestrator;
  readonly subAgentCoordinator: SubAgentCoordinator;
  readonly smartModelRouter: SmartModelRouter;
  readonly modelOrchestrator: ModelOrchestrator;
  readonly planService: PlanService;
  readonly routeLogStore: RouteLogStore;
  readonly modelCallLogStore: ModelCallLogStore;
  readonly modelAvailability: ModelAvailabilityRegistry;
  readonly collaborationRunStore: CollaborationRunStore;
  readonly fallbackLogStore: FallbackLogStore;
  readonly modelEvalStore: ModelEvalStore;
  readonly evalSetRunner: EvalSetRunner;
  readonly modelProfileStore: ModelProfileStore;
  readonly modelProfileRegistry: ModelRegistry;
  readonly projectAllowedPermissions: ToolPermission[];
  readonly shellPolicy: ShellPolicy;
  readonly networkPolicy: NetworkPolicy;
  readonly dataLifecycle: DataLifecycleService;
  private readonly defaultAgentChat: LoopChatFn;
  readonly startupRecovery?: StartupRecoverySummary;

  constructor(opts: {
    profile: string;
    config: AppConfig;
    workspaceRoot: string;
    paths: AppPaths;
    clientMap: Map<string, ModelClient>;
    metrics: MetricsRegistry;
    trace: TraceLogger;
    traceCatalog: TraceCatalog;
    notificationQueue: NotificationQueue;
    scheduler: Scheduler;
    backgroundTasks: BackgroundTaskManager;
    directChat: ReturnType<typeof createDirectChatFn>;
    planner: Planner;
    registry: ReturnType<typeof createDefaultRegistry>;
    contextManager: ContextManager;
    runs: RunStore;
    runStateStore: RunStateStore;
    projectIndex: ProjectIndex;
    projectSemanticIndexer: ProjectSemanticIndexer;
    historyFileRecaller: HistoryFileRecaller;
    orchestrator: Orchestrator;
    subAgentCoordinator: SubAgentCoordinator;
    smartModelRouter: SmartModelRouter;
    modelOrchestrator: ModelOrchestrator;
    planService: PlanService;
    routeLogStore: RouteLogStore;
    modelCallLogStore: ModelCallLogStore;
    modelAvailability: ModelAvailabilityRegistry;
    collaborationRunStore: CollaborationRunStore;
    fallbackLogStore: FallbackLogStore;
    modelEvalStore: ModelEvalStore;
    evalSetRunner: EvalSetRunner;
    modelProfileStore: ModelProfileStore;
    modelProfileRegistry: ModelRegistry;
    defaultAgentChat: LoopChatFn;
    projectAllowedPermissions: ToolPermission[];
    shellPolicy: ShellPolicy;
    networkPolicy: NetworkPolicy;
    dataLifecycle: DataLifecycleService;
    startupRecovery?: StartupRecoverySummary;
  }) {
    this.profile = opts.profile;
    this.config = opts.config;
    this.workspaceRoot = opts.workspaceRoot;
    this.paths = opts.paths;
    this.clientMap = opts.clientMap;
    this.metrics = opts.metrics;
    this.trace = opts.trace;
    this.traceCatalog = opts.traceCatalog;
    this.notificationQueue = opts.notificationQueue;
    this.scheduler = opts.scheduler;
    this.backgroundTasks = opts.backgroundTasks;
    this.directChat = opts.directChat;
    this.planner = opts.planner;
    this.registry = opts.registry;
    this.contextManager = opts.contextManager;
    this.runs = opts.runs;
    this.runStateStore = opts.runStateStore;
    this.projectIndex = opts.projectIndex;
    this.projectSemanticIndexer = opts.projectSemanticIndexer;
    this.historyFileRecaller = opts.historyFileRecaller;
    this.orchestrator = opts.orchestrator;
    this.subAgentCoordinator = opts.subAgentCoordinator;
    this.smartModelRouter = opts.smartModelRouter;
    this.modelOrchestrator = opts.modelOrchestrator;
    this.planService = opts.planService;
    this.routeLogStore = opts.routeLogStore;
    this.modelCallLogStore = opts.modelCallLogStore;
    this.modelAvailability = opts.modelAvailability;
    this.collaborationRunStore = opts.collaborationRunStore;
    this.fallbackLogStore = opts.fallbackLogStore;
    this.modelEvalStore = opts.modelEvalStore;
    this.evalSetRunner = opts.evalSetRunner;
    this.modelProfileStore = opts.modelProfileStore;
    this.modelProfileRegistry = opts.modelProfileRegistry;
    this.defaultAgentChat = opts.defaultAgentChat;
    this.projectAllowedPermissions = opts.projectAllowedPermissions;
    this.shellPolicy = opts.shellPolicy;
    this.networkPolicy = opts.networkPolicy;
    this.dataLifecycle = opts.dataLifecycle;
    this.startupRecovery = opts.startupRecovery;
  }

  makeChatFn(forceClient?: string): LoopChatFn {
    if (forceClient) {
      return (req, opts) =>
        this.directChat(req, {
          sensitive: opts?.sensitive,
          taskType: opts?.taskType,
          forceClient,
        });
    }
    return this.defaultAgentChat;
  }

  subAgentCoordinatorFor(forceClient?: string): SubAgentCoordinator {
    if (!forceClient) return this.subAgentCoordinator;
    return new SubAgentCoordinator({
      chat: this.makeChatFn(forceClient),
      registry: this.registry,
      workspaceRoot: this.workspaceRoot,
      trace: this.trace,
      projectAllowedPermissions: this.projectAllowedPermissions,
      maxBatchConcurrency: this.config.security?.subagent?.maxBatchConcurrency ?? 2,
    });
  }

  resolveForceClient(clientName?: string): { forceClient?: string; error?: string } {
    if (!clientName || clientName === "__default__") return {};
    if (!this.clientMap.has(clientName)) {
      return { error: `未找到模型客户端：${clientName}` };
    }
    return { forceClient: clientName };
  }

  getConfigPayload() {
    return {
      profile: this.profile,
      workspaceRoot: this.workspaceRoot,
      routing: this.config.routing,
      defaultModel: this.config.models.default,
      clients: this.config.models.clients.map((c) => ({
        name: c.name,
        provider: c.provider,
        location: c.location,
        model: c.model,
        availability: this.modelAvailability.get(c.name),
      })),
      capabilities: {
        traceAudit: true,
        contextPersistence: true,
        subAgent: true,
        scheduler: true,
        traceReplay: true,
        orchestrator: true,
        runsApi: true,
        sensitiveDetection: true,
        modelPromptRedaction: true,
        agentDecisionTrace: true,
        taskStatusTrace: true,
        toolCallTrace: true,
        modelUsageTrace: true,
        toolErrorCategory: true,
        toolStorageRedaction: true,
        highRiskConfirmation: true,
        localFirstPrivacyMode: true,
        plannerSmartRouting: true,
        agentSmartRouting: true,
        subAgentSmartRouting: true,
        startupRecovery: true,
        runReportExport: true,
        runReportTimeline: true,
        traceReplayFilters: true,
        traceSegmentRotation: true,
        traceIndex: true,
        privacyPurge: true,
        storageLifecycle: true,
        modelTokenStreaming: true,
        routerEvaluatorV3: true,
        answerEvaluatorV4: true,
        runtimeStatsV6: true,
        evalSetRunnerV7: true,
        modelCapabilitiesV5: true,
        contextAnalyzerV8: true,
        promptStrategyBuilderV8: true,
        runtimeStatsFeedbackV8: true,
        agentPromptStrategyV8: true,
        costBudgetManagerV8: true,
        modelProfileStoreV8: true,
        modelAvailabilityRouting: true,
        runPolicyManager: true,
        budgetManager: true,
        finalizer: true,
        toolResultLayers: true,
        runStateStore: true,
        projectIndex: true,
        symbolSearch: true,
        projectSemanticLocate: true,
        moduleDependencyGraph: true,
        historyFileRecall: true,
        projectIndexUpdate: true,
        costBudgetPerRun: true,
        ruleOnlyRouting: true,
        dataLifecycleRetention: true,
        permissionScopeResolution: true,
        sqliteSchemaMigrations: true,
        networkDomainPolicy: true,
        structuredToolRisk: true,
      },
      security: {
        permissions: {
          allowed: this.projectAllowedPermissions,
          scopeOrder: [...PERMISSION_SCOPE_ORDER],
        },
        network: {
          denyDomains: this.config.security?.network?.denyDomains ?? [],
          allowDomains: this.config.security?.network?.allowDomains ?? [],
        },
      },
      schemaVersions: {
        memory: {
          path: this.contextManager.db.dbPath,
          version: this.contextManager.db.schemaVersion,
          migrations: this.contextManager.db.schemaInfo.migrations.map((m) => m.name),
        },
        tools: (() => {
          const storage = this.registry.getStorage();
          if (!storage) return undefined;
          return {
            path: storage.dbPath,
            version: storage.schemaVersion,
            migrations: storage.schemaInfo.migrations.map((m) => m.name),
          };
        })(),
      },
      startupRecovery: this.startupRecovery,
    };
  }

  /**
   * 有序优雅关闭：先停调度器、取消进行中的运行与后台任务并给收尾时间，
   * 再 flush/关闭 trace 与索引，最后关数据库连接——避免「关库后仍有写入」与孤儿进程。
   */
  async shutdown(): Promise<void> {
    this.scheduler.stop();

    try {
      for (const r of this.orchestrator.listRunningAgentRuns()) {
        this.orchestrator.cancelRun(r.runId);
      }
    } catch {
      /* best-effort 取消 */
    }
    try {
      for (const t of this.backgroundTasks.list()) {
        if (t.status === "running") this.backgroundTasks.cancel(t.id);
      }
    } catch {
      /* best-effort 取消 */
    }

    await this.waitForActiveRuns(5_000);

    await this.trace.close();
    this.trace.getIndexStore()?.close();
    this.registry.close();
    this.contextManager.db.close();
  }

  private async waitForActiveRuns(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let running = 0;
      try {
        running = this.orchestrator.listRunningAgentRuns().length;
      } catch {
        return;
      }
      if (running === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

export function createAppContext(): AppContext {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(moduleDir, "..", "..");
  const repoRoot = path.resolve(projectRoot, "..");
  const dataDir = path.join(projectRoot, "data");

  const paths: AppPaths = {
    projectRoot,
    repoRoot,
    publicDir: path.join(projectRoot, "public"),
    docsDir: path.join(repoRoot, "docs"),
    docsAssetsDir: path.join(repoRoot, "docs", "assets"),
    dataDir,
    tracesDir: path.join(dataDir, "traces"),
    traceFile: path.join(dataDir, "traces", "active", "trace-current.jsonl"),
  };

  const lifecyclePolicy = loadLifecyclePolicy(dataDir);
  const { logger: trace, index: traceIndex } = createSegmentedTraceLogger(paths.tracesDir, {
    rotationMaxBytes: lifecyclePolicy.trace.rotationMaxBytes,
    rotationMaxAgeHours: lifecyclePolicy.trace.rotationMaxAgeHours,
    compressOldSegments: lifecyclePolicy.trace.compressOldSegments,
  });
  const traceCatalog: TraceCatalog = { tracesDir: paths.tracesDir, index: traceIndex };

  const { profile, config, workspaceRoot } = loadConfig();
  const shellPolicy = createShellPolicy(config.security?.shell);
  const networkPolicy = createNetworkPolicy(config.security?.network);
  const projectAllowedPermissions = resolveProjectAllowedPermissions(config.security?.permissions);
  const maxSubAgentDispatchDepth = config.security?.subagent?.maxDispatchDepth ?? 1;
  const maxSubAgentBatchConcurrency = config.security?.subagent?.maxBatchConcurrency ?? 2;
  const subagentDefaultTimeoutMs = config.security?.subagent?.defaultTimeoutMs;
  const subagentLocalMaxConcurrent = config.security?.subagent?.localModelMaxConcurrent ?? 1;
  if (subagentDefaultTimeoutMs) {
    setSubagentDefaultTimeoutMs(subagentDefaultTimeoutMs);
  }
  initSubAgentLocalQueueGate(subagentLocalMaxConcurrent);

  const clientMap = new Map<string, ModelClient>();
  const pricing = new Map<string, ClientPricing>();
  for (const c of config.models.clients) {
    clientMap.set(c.name, createModelClient(c));
    if (c.pricePer1kInputUsd !== undefined || c.pricePer1kOutputUsd !== undefined) {
      pricing.set(c.name, { inputPer1k: c.pricePer1kInputUsd, outputPer1k: c.pricePer1kOutputUsd });
    }
  }

  const metrics = new MetricsRegistry();
  const modelAvailability = new ModelAvailabilityRegistry();
  const notificationQueue = new NotificationQueue(
    path.join(dataDir, "notifications", "notifications.jsonl"),
  );

  const schedCfg = config.scheduler;
  const scheduler = new Scheduler(
    path.join(dataDir, "scheduler", "triggers.jsonl"),
    notificationQueue,
    trace,
    {
      workspaceRoot,
      unattendedGoalPatterns: schedCfg?.unattendedGoalPatterns ?? [],
      gitPollIntervalMs: schedCfg?.gitPollIntervalMs ?? 5000,
      defaultCronMissPolicy: schedCfg?.cronMissPolicy ?? "skip",
    },
  );

  const orchestratorHolder: { current?: Orchestrator } = {};

  const backgroundTasks = new BackgroundTaskManager(
    workspaceRoot,
    notificationQueue,
    trace,
    (record) => scheduler.handleBackgroundCompleted(record),
    (input) => {
      const orch = orchestratorHolder.current;
      if (!orch) return;
      void orch
        .executeUnattendedTrigger({
          triggerId: `background:${input.record.id}`,
          goal: input.goal,
        })
        .then(({ runId }) => {
          backgroundTasks.markTriggeredRun(input.record.id, runId);
        })
        .catch((error) => {
          trace.write({
            type: "background_trigger_next_error",
            taskId: input.record.id,
            error: String(error),
          });
        });
    },
    shellPolicy,
  );

  const directChat = createDirectChatFn([...clientMap.values()], {
    strategy: config.routing.strategy,
    fallback: config.routing.fallback,
    metrics,
    trace,
    pricing,
  });

  const registry = createDefaultRegistry({ trace, dataDir, shellPolicy, networkPolicy });
  const contextManager = new ContextManager({ dataDir, useLanceDb: true });
  const runs = new RunStore(contextManager.db);
  const runStateStore = new RunStateStore(contextManager.db);
  const projectIndex = new ProjectIndex(contextManager.db);
  const projectSemanticIndexer = new ProjectSemanticIndexer(
    contextManager.embeddings,
    contextManager.vectors,
  );
  const historyFileRecaller = new HistoryFileRecaller(
    contextManager.db,
    contextManager.memories,
    contextManager.retriever,
  );
  registry.setDefaultContext({ projectIndex, projectSemanticIndexer, historyFileRecaller });

  const modelProfiles = buildModelProfiles(config.models.clients);
  for (const msg of validateModelProfiles(modelProfiles)) {
    console.warn(`[model-router] 配置校验：${msg}`);
  }
  for (const msg of validateCapabilityMatrixCoverage(modelProfiles)) {
    console.warn(`[model-router] 能力矩阵覆盖：${msg}`);
  }
  const modelProfileStore = ModelProfileStore.fromClients(config.models.clients, {
    db: contextManager.db.connection,
    metrics,
    availability: modelAvailability,
  });
  const profileRegistry = modelProfileStore.registry;
  const routeLogStore = new RouteLogStore(contextManager.db.connection);
  const modelCallLogStore = new ModelCallLogStore(contextManager.db.connection);
  const collaborationRunStore = new CollaborationRunStore(contextManager.db.connection);
  const fallbackLogStore = new FallbackLogStore(contextManager.db.connection);
  const modelEvalStore = new ModelEvalStore(contextManager.db.connection);
  const evalSetRunner = new EvalSetRunner(profileRegistry, modelEvalStore);
  const fallbackManager = new FallbackManager(profileRegistry);
  const runtimeStatsFeedback = new RuntimeStatsFeedback(contextManager.db.connection);
  const smartModelRouter = new SmartModelRouter(
    profileRegistry,
    routeLogStore,
    runtimeStatsFeedback,
  );
  const modelChatFn = createModelChatFn(clientMap, modelCallLogStore, trace, modelAvailability);
  const defaultAgentChat = createAgentChatFn({ smartRouter: smartModelRouter, modelChatFn });
  const createChatForDelegatedTask = createDelegatedTaskChatFn({
    smartRouter: smartModelRouter,
    modelChatFn,
  });
  const planner = new Planner(
    createPlannerChatFn({ smartRouter: smartModelRouter, modelChatFn }),
  );
  const modelOrchestrator = new ModelOrchestrator(
    modelChatFn,
    collaborationRunStore,
    fallbackManager,
    fallbackLogStore,
  );

  const makeChatFn = (forceClient?: string): LoopChatFn =>
    forceClient
      ? (req, opts) =>
          directChat(req, {
            sensitive: opts?.sensitive,
            taskType: opts?.taskType,
            forceClient,
          })
      : defaultAgentChat;

  const subAgentRunRegistry = new SubAgentRunRegistry();
  const agentRunRegistry = new AgentRunRegistry();

  const subAgentCoordinator = new SubAgentCoordinator({
    chat: defaultAgentChat,
    createChatForDelegatedTask,
    registry,
    workspaceRoot,
    trace,
    projectAllowedPermissions,
    notificationQueue,
    maxSubAgentDispatchDepth,
    maxBatchConcurrency: maxSubAgentBatchConcurrency,
    runRegistry: subAgentRunRegistry,
  });

  registry.setDefaultContext({
    subAgentCoordinator,
    projectAllowedPermissions,
    maxSubAgentDispatchDepth,
  });

  void modelAvailability.refreshAll(clientMap).catch((error) => {
    trace.write({
      type: "model_availability_refresh_error",
      error: String(error),
    });
  });

  const planStore = new PlanStore(contextManager.db);
  const planValidator = new PlanValidator({
    workspaceRoot,
    registry,
  });
  const planApproval = new PlanApprovalManager(planStore);
  const planService = new PlanService({
    workspaceRoot,
    store: planStore,
    validator: planValidator,
    approval: planApproval,
    registry,
    trace,
  });

  const orchestrator = new Orchestrator({
    workspaceRoot,
    directChat,
    planner,
    registry,
    contextManager,
    tasks: contextManager.tasks,
    runs,
    runStateStore,
    projectIndex,
    notificationQueue,
    trace,
    makeChatFn,
    subAgentCoordinator,
    subAgentCoordinatorFor: (forceClient) =>
      forceClient
        ? new SubAgentCoordinator({
            chat: makeChatFn(forceClient),
            registry,
            workspaceRoot,
            trace,
            projectAllowedPermissions,
            notificationQueue,
            maxSubAgentDispatchDepth,
            maxBatchConcurrency: maxSubAgentBatchConcurrency,
            runRegistry: subAgentRunRegistry,
          })
        : subAgentCoordinator,
    smartModelRouter,
    modelOrchestrator,
    planService,
    maxCostUsdPerRun: config.security?.budget?.maxCostUsdPerRun,
    projectAllowedPermissions,
    maxSubAgentDispatchDepth,
    agentRunRegistry,
  });
  orchestratorHolder.current = orchestrator;

  scheduler.setFireHandler((ctx) => {
    if (ctx.unattended) {
      void orchestrator.executeUnattendedTrigger({
        triggerId: ctx.triggerId,
        goal: ctx.goal,
        sessionId: ctx.sessionId,
      });
      return undefined;
    } else {
      return orchestrator.createScheduledRun({
        triggerId: ctx.triggerId,
        goal: ctx.goal,
        sessionId: ctx.sessionId,
      });
    }
  });

  const startupRecovery = recoverOnStartup({ runs, notificationQueue, trace });

  const toolsDbPath = registry.getStorage()?.dbPath;
  const dataLifecycle = new DataLifecycleService({
    dataDir,
    workspaceRoot,
    traceFile: paths.traceFile,
    tracesDir: paths.tracesDir,
    traceCatalog,
    notificationFile: path.join(dataDir, "notifications", "notifications.jsonl"),
    schedulerJournalFile: path.join(dataDir, "scheduler", "triggers.jsonl"),
    memoryDb: contextManager.db,
    toolsDbPath,
    getActiveRunIds: () => agentRunRegistry.listRunning().map((r) => r.runId),
  });

  const app = new AppContext({
    profile,
    config,
    workspaceRoot,
    paths,
    clientMap,
    metrics,
    trace,
    traceCatalog,
    notificationQueue,
    scheduler,
    backgroundTasks,
    directChat,
    planner,
    registry,
    contextManager,
    runs,
    runStateStore,
    projectIndex,
    projectSemanticIndexer,
    historyFileRecaller,
    orchestrator,
    subAgentCoordinator,
    smartModelRouter,
    modelOrchestrator,
    planService,
    routeLogStore,
    modelCallLogStore,
    modelAvailability,
    collaborationRunStore,
    fallbackLogStore,
    modelEvalStore,
    evalSetRunner,
    modelProfileStore,
    modelProfileRegistry: profileRegistry,
    defaultAgentChat,
    projectAllowedPermissions,
    shellPolicy,
    networkPolicy,
    dataLifecycle,
    startupRecovery,
  });
  if (startupRecovery.interruptedRuns > 0 || startupRecovery.pendingNotifications > 0) {
    console.warn(
      `[startupRecovery] interruptedRuns=${startupRecovery.interruptedRuns} pendingNotifications=${startupRecovery.pendingNotifications}`,
    );
  }
  scheduler.start();
  if (lifecyclePolicy.cleanup.autoEnabled) {
    const intervalMs = lifecyclePolicy.cleanup.autoIntervalHours * 60 * 60 * 1000;
    const runAutoCleanup = (): void => {
      try {
        const result = dataLifecycle.runAutoSafeCleanup();
        if ("autoSkipped" in result) return;
        console.log(
          `[lifecycle] auto cleanup ${result.cleanupRunId}: freed ${result.bytesFreed} bytes (${result.applied} actions)`,
        );
      } catch (error) {
        console.warn(`[lifecycle] auto cleanup failed: ${String(error)}`);
      }
    };
    setTimeout(runAutoCleanup, 60_000);
    setInterval(runAutoCleanup, intervalMs);
  }
  if (schedCfg?.dailySummaryCron && schedCfg.dailySummaryGoal) {
    const hasDaily = scheduler.list().some((t) => t.name === "__daily_summary__");
    if (!hasDaily) {
      scheduler.register({
        name: "__daily_summary__",
        kind: "cron",
        goal: schedCfg.dailySummaryGoal,
        cron: schedCfg.dailySummaryCron,
        cronMissPolicy: schedCfg.cronMissPolicy ?? "skip",
      });
    }
  }

  return app;
}
