import path from "node:path";
import { fileURLToPath } from "node:url";

import { Planner } from "../agent/Planner.js";
import type { LoopChatFn } from "../agent/AgentLoop.js";
import { BackgroundTaskManager, NotificationQueue } from "../background/index.js";
import { loadConfig } from "../config/loadConfig.js";
import type { AppConfig } from "../config/types.js";
import { ContextManager } from "../context/index.js";
import { createModelClient } from "../model/ModelFactory.js";
import { MetricsRegistry } from "../model/MetricsRegistry.js";
import { ModelRouter, type ClientPricing } from "../model/ModelRouter.js";
import type { ModelClient } from "../model/types.js";
import { Orchestrator } from "../orchestrator/Orchestrator.js";
import { RunStore } from "../orchestrator/RunStore.js";
import { Scheduler } from "../scheduler/index.js";
import { SubAgentCoordinator } from "../subagent/index.js";
import { createDefaultRegistry } from "../tools/index.js";
import { ModelOrchestrator } from "../model-orchestrator/index.js";
import {
  buildModelProfiles,
  CollaborationRunStore,
  createModelChatFn,
  ModelCallLogStore,
  ModelRegistry,
  RouteLogStore,
  SmartModelRouter,
} from "../model-router/index.js";
import { TraceLogger } from "../trace/TraceLogger.js";

export interface AppPaths {
  projectRoot: string;
  repoRoot: string;
  publicDir: string;
  docsDir: string;
  docsAssetsDir: string;
  dataDir: string;
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
  readonly notificationQueue: NotificationQueue;
  readonly scheduler: Scheduler;
  readonly backgroundTasks: BackgroundTaskManager;
  readonly modelRouter: ModelRouter;
  readonly planner: Planner;
  readonly registry: ReturnType<typeof createDefaultRegistry>;
  readonly contextManager: ContextManager;
  readonly runs: RunStore;
  readonly orchestrator: Orchestrator;
  readonly subAgentCoordinator: SubAgentCoordinator;
  readonly smartModelRouter: SmartModelRouter;
  readonly modelOrchestrator: ModelOrchestrator;

  constructor(opts: {
    profile: string;
    config: AppConfig;
    workspaceRoot: string;
    paths: AppPaths;
    clientMap: Map<string, ModelClient>;
    metrics: MetricsRegistry;
    trace: TraceLogger;
    notificationQueue: NotificationQueue;
    scheduler: Scheduler;
    backgroundTasks: BackgroundTaskManager;
    modelRouter: ModelRouter;
    planner: Planner;
    registry: ReturnType<typeof createDefaultRegistry>;
    contextManager: ContextManager;
    runs: RunStore;
    orchestrator: Orchestrator;
    subAgentCoordinator: SubAgentCoordinator;
    smartModelRouter: SmartModelRouter;
    modelOrchestrator: ModelOrchestrator;
  }) {
    this.profile = opts.profile;
    this.config = opts.config;
    this.workspaceRoot = opts.workspaceRoot;
    this.paths = opts.paths;
    this.clientMap = opts.clientMap;
    this.metrics = opts.metrics;
    this.trace = opts.trace;
    this.notificationQueue = opts.notificationQueue;
    this.scheduler = opts.scheduler;
    this.backgroundTasks = opts.backgroundTasks;
    this.modelRouter = opts.modelRouter;
    this.planner = opts.planner;
    this.registry = opts.registry;
    this.contextManager = opts.contextManager;
    this.runs = opts.runs;
    this.orchestrator = opts.orchestrator;
    this.subAgentCoordinator = opts.subAgentCoordinator;
    this.smartModelRouter = opts.smartModelRouter;
    this.modelOrchestrator = opts.modelOrchestrator;
  }

  makeChatFn(forceClient?: string): LoopChatFn {
    return (req, opts) =>
      this.modelRouter.chat(req, {
        sensitive: opts?.sensitive,
        taskType: opts?.taskType,
        ...(forceClient ? { forceClient } : {}),
      });
  }

  subAgentCoordinatorFor(forceClient?: string): SubAgentCoordinator {
    if (!forceClient) return this.subAgentCoordinator;
    return new SubAgentCoordinator({
      chat: this.makeChatFn(forceClient),
      registry: this.registry,
      workspaceRoot: this.workspaceRoot,
      trace: this.trace,
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
      })),
      capabilities: {
        traceAudit: true,
        contextPersistence: true,
        subAgent: true,
        scheduler: true,
        traceReplay: true,
        orchestrator: true,
        runsApi: true,
      },
    };
  }

  shutdown(): void {
    this.scheduler.stop();
    this.registry.close();
    this.contextManager.db.close();
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
    traceFile: path.join(dataDir, "traces", "trace.jsonl"),
  };

  const { profile, config, workspaceRoot } = loadConfig();

  const clientMap = new Map<string, ModelClient>();
  const pricing = new Map<string, ClientPricing>();
  for (const c of config.models.clients) {
    clientMap.set(c.name, createModelClient(c));
    if (c.pricePer1kInputUsd !== undefined || c.pricePer1kOutputUsd !== undefined) {
      pricing.set(c.name, { inputPer1k: c.pricePer1kInputUsd, outputPer1k: c.pricePer1kOutputUsd });
    }
  }

  const metrics = new MetricsRegistry();
  const trace = new TraceLogger(paths.traceFile);
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

  const backgroundTasks = new BackgroundTaskManager(
    workspaceRoot,
    notificationQueue,
    trace,
    (record) => scheduler.handleBackgroundCompleted(record),
  );

  const modelRouter = new ModelRouter([...clientMap.values()], {
    strategy: config.routing.strategy,
    fallback: config.routing.fallback,
    metrics,
    trace,
    pricing,
  });

  const planner = new Planner((request, opts) => modelRouter.chat(request, opts));
  const registry = createDefaultRegistry({ trace, dataDir });
  const contextManager = new ContextManager({ dataDir, useLanceDb: true });
  const runs = new RunStore(contextManager.db);

  const modelProfiles = buildModelProfiles(config.models.clients);
  const profileRegistry = new ModelRegistry(modelProfiles);
  const routeLogStore = new RouteLogStore(contextManager.db.connection);
  const modelCallLogStore = new ModelCallLogStore(contextManager.db.connection);
  const collaborationRunStore = new CollaborationRunStore(contextManager.db.connection);
  const smartModelRouter = new SmartModelRouter(profileRegistry, routeLogStore);
  const modelChatFn = createModelChatFn(clientMap, modelCallLogStore, trace);
  const modelOrchestrator = new ModelOrchestrator(modelChatFn, collaborationRunStore);

  const makeChatFn = (forceClient?: string): LoopChatFn => (req, opts) =>
    modelRouter.chat(req, {
      sensitive: opts?.sensitive,
      taskType: opts?.taskType,
      ...(forceClient ? { forceClient } : {}),
    });

  const subAgentCoordinator = new SubAgentCoordinator({
    chat: (req, opts) =>
      modelRouter.chat(req, { sensitive: opts?.sensitive, taskType: opts?.taskType }),
    registry,
    workspaceRoot,
    trace,
  });

  const orchestrator = new Orchestrator({
    workspaceRoot,
    modelRouter,
    planner,
    registry,
    contextManager,
    tasks: contextManager.tasks,
    runs,
    notificationQueue,
    trace,
    makeChatFn,
    subAgentCoordinator,
    subAgentCoordinatorFor: (forceClient) =>
      new SubAgentCoordinator({
        chat: (req, opts) =>
          modelRouter.chat(req, {
            sensitive: opts?.sensitive,
            ...(forceClient ? { forceClient } : {}),
          }),
        registry,
        workspaceRoot,
        trace,
      }),
    smartModelRouter,
    modelOrchestrator,
  });

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

  const app = new AppContext({
    profile,
    config,
    workspaceRoot,
    paths,
    clientMap,
    metrics,
    trace,
    notificationQueue,
    scheduler,
    backgroundTasks,
    modelRouter,
    planner,
    registry,
    contextManager,
    runs,
    orchestrator,
    subAgentCoordinator,
    smartModelRouter,
    modelOrchestrator,
  });

  scheduler.start();
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
