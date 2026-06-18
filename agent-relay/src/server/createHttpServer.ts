import { createServer, type Server } from "node:http";

import type { AppContext } from "../app/createAppContext.js";
import {
  handleActivityRunEvents,
  handleActivityRunGet,
  handleAgent,
  handleAgentResume,
  handleAgentStream,
  handleChat,
  handleChatStream,
  handlePlan,
  handleTaskDryRun,
  handleTaskRun,
} from "./handlers/agent.handlers.js";
import { handleRoutingEvalRun, handleRoutingEvalRuns, handleRoutingLogs, handleRoutingProfiles, handleRoutingStats } from "./handlers/routing.handlers.js";
import { handleTaskGet, handleTaskResume, handleTasksList } from "./handlers/task.handlers.js";
import {
  handleBackgroundCancel,
  handleBackgroundGet,
  handleBackgroundList,
  handleBackgroundStart,
  handleNotificationsConsume,
  handleNotificationsList,
} from "./handlers/background.handlers.js";
import { getConfig, metrics, modelsCatalog, modelsCheck } from "./handlers/config.handlers.js";
import {
  handleContextMemoriesList,
  handleContextMemoryCreate,
  handleContextMemoryDeactivate,
  handleContextProjectIndex,
  handleContextSearch,
  handleContextSessionCompress,
  handleContextSessionCreate,
  handleContextSessionGet,
  handleContextSessionRestore,
  handleContextSessionUpdate,
  handleContextSessionsList,
} from "./handlers/context.handlers.js";
import {
  handleStorageCleanupApply,
  handleStorageCleanupPreview,
  handleStorageCleanupRuns,
  handleStorageUsage,
  handleContextSessionDeleteWithLifecycle,
  handleContextSessionPurge,
} from "./handlers/storage.handlers.js";
import { handleDocContent, handleDocsList } from "./handlers/docs.handlers.js";
import { handleRunCancel, handleRunDelete, handleRunGet, handleRunReport, handleRunsList, handleRunsRunning } from "./handlers/runs.handlers.js";
import {
  handlePermissionRequestGet,
  handlePermissionRequestRespond,
  handlePermissionRequestsPending,
  handleRunApprove,
} from "./handlers/permission.handlers.js";
import {
  handleSchedulerCancel,
  handleSchedulerCreate,
  handleSchedulerList,
  handleSchedulerPause,
  handleSchedulerResume,
} from "./handlers/scheduler.handlers.js";
import {
  handlePlanActivate,
  handlePlanApprove,
  handlePlanAnalyze,
  handlePlanCompile,
  handlePlanDraft,
  handlePlanExecute,
  handlePlanGet,
  handlePlanImportPreview,
  handlePlanPreview,
  handlePlanReject,
  handlePlanRevise,
} from "./handlers/plan.handlers.js";
import { handleSubAgentBatch, handleSubAgentCancel, handleSubAgentRun, handleSubAgentRunning, handleSubAgentSchedule } from "./handlers/subagent.handlers.js";
import { handleToolsList, handleToolRun } from "./handlers/tools.handlers.js";
import { handleTraceExport, handleTraceRecent, handleTraceReplay, handleTraceRotate } from "./handlers/trace.handlers.js";
import { readBody } from "./http/body.js";
import { HttpError, sendJson } from "./http/response.js";
import { serveDocsAsset, serveStatic } from "./http/static.js";

export interface HttpServerOptions {
  maxBodyBytes?: number;
}

export function createHttpServer(app: AppContext, opts?: HttpServerOptions): Server {
  const maxBodyBytes = opts?.maxBodyBytes ?? Number(process.env.AGENT_RELAY_MAX_BODY_BYTES ?? 1_048_576);

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const { pathname } = url;
      const method = req.method ?? "GET";

      try {
        if (pathname === "/api/config" && method === "GET") {
          sendJson(res, 200, getConfig(app));
          return;
        }
        if (pathname === "/api/models/check" && method === "GET") {
          sendJson(res, 200, await modelsCheck(app));
          return;
        }
        if (pathname === "/api/models/catalog" && method === "GET") {
          sendJson(res, 200, await modelsCatalog(app));
          return;
        }
        if (pathname === "/api/chat/stream" && method === "POST") {
          await handleChatStream(app, await readBody(req, maxBodyBytes), res);
          return;
        }
        if (pathname === "/api/chat" && method === "POST") {
          const result = await handleChat(app, await readBody(req, maxBodyBytes));
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/metrics" && method === "GET") {
          sendJson(res, 200, metrics(app));
          return;
        }
        if (pathname === "/api/storage/usage" && method === "GET") {
          const result = handleStorageUsage(app);
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/storage/cleanup/preview" && method === "POST") {
          const result = handleStorageCleanupPreview(app, await readBody(req, maxBodyBytes));
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/storage/cleanup/apply" && method === "POST") {
          const result = handleStorageCleanupApply(app, await readBody(req, maxBodyBytes));
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/storage/cleanup/runs" && method === "GET") {
          const result = handleStorageCleanupRuns(app, url);
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/trace/recent" && method === "GET") {
          const result = handleTraceRecent(app, url);
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/trace/export" && method === "GET") {
          const result = await handleTraceExport(app, url);
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/trace/replay" && method === "GET") {
          const result = await handleTraceReplay(app, url);
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/trace/rotate" && method === "POST") {
          const result = handleTraceRotate(app);
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/plan" && method === "POST") {
          const result = await handlePlan(app, await readBody(req, maxBodyBytes));
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/plans/draft" && method === "POST") {
          const result = await handlePlanDraft(app, await readBody(req, maxBodyBytes));
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/plans/analyze" && method === "POST") {
          const result = await handlePlanAnalyze(app, await readBody(req, maxBodyBytes));
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/plans/import-preview" && method === "POST") {
          const result = await handlePlanImportPreview(app, await readBody(req, maxBodyBytes));
          sendJson(res, result.status, result.body);
          return;
        }
        const planReviseMatch = pathname.match(/^\/api\/plans\/([^/]+)\/revise$/);
        if (planReviseMatch && method === "POST") {
          const result = await handlePlanRevise(
            app,
            planReviseMatch[1]!,
            await readBody(req, maxBodyBytes),
          );
          sendJson(res, result.status, result.body);
          return;
        }
        const planCompileMatch = pathname.match(/^\/api\/plans\/([^/]+)\/compile$/);
        if (planCompileMatch && method === "POST") {
          const result = await handlePlanCompile(
            app,
            planCompileMatch[1]!,
            await readBody(req, maxBodyBytes),
          );
          sendJson(res, result.status, result.body);
          return;
        }
        const planActivateMatch = pathname.match(/^\/api\/plans\/([^/]+)\/activate$/);
        if (planActivateMatch && method === "POST") {
          const result = await handlePlanActivate(
            app,
            planActivateMatch[1]!,
            await readBody(req, maxBodyBytes),
          );
          sendJson(res, result.status, result.body);
          return;
        }
        const planPreviewMatch = pathname.match(/^\/api\/plans\/([^/]+)\/preview$/);
        if (planPreviewMatch && method === "GET") {
          const result = await handlePlanPreview(app, planPreviewMatch[1]!, url);
          sendJson(res, result.status, result.body);
          return;
        }
        const planApproveMatch = pathname.match(/^\/api\/plans\/([^/]+)\/approve$/);
        if (planApproveMatch && method === "POST") {
          const result = await handlePlanApprove(
            app,
            planApproveMatch[1]!,
            await readBody(req, maxBodyBytes),
          );
          sendJson(res, result.status, result.body);
          return;
        }
        const planRejectMatch = pathname.match(/^\/api\/plans\/([^/]+)\/reject$/);
        if (planRejectMatch && method === "POST") {
          const result = await handlePlanReject(
            app,
            planRejectMatch[1]!,
            await readBody(req, maxBodyBytes),
          );
          sendJson(res, result.status, result.body);
          return;
        }
        const planExecuteMatch = pathname.match(/^\/api\/plans\/([^/]+)\/execute$/);
        if (planExecuteMatch && method === "POST") {
          const result = await handlePlanExecute(
            app,
            planExecuteMatch[1]!,
            await readBody(req, maxBodyBytes),
          );
          sendJson(res, result.status, result.body);
          return;
        }
        const planGetMatch = pathname.match(/^\/api\/plans\/([^/]+)$/);
        if (planGetMatch && method === "GET") {
          const result = await handlePlanGet(app, planGetMatch[1]!);
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/task/dry-run" && method === "POST") {
          const result = await handleTaskDryRun(app, await readBody(req, maxBodyBytes));
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/task/run" && method === "POST") {
          const result = await handleTaskRun(app, await readBody(req, maxBodyBytes));
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/routing/logs" && method === "GET") {
          const result = handleRoutingLogs(app, url);
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/routing/profiles" && method === "GET") {
          const result = handleRoutingProfiles(app);
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/routing/stats" && method === "GET") {
          const result = handleRoutingStats(app, url);
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/routing/eval/run" && method === "POST") {
          const result = handleRoutingEvalRun(app, await readBody(req, maxBodyBytes));
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/routing/eval/runs" && method === "GET") {
          const result = handleRoutingEvalRuns(app, url);
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/tasks" && method === "GET") {
          const result = handleTasksList(app, url.searchParams.get("sessionId") ?? undefined);
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname.startsWith("/api/tasks/") && pathname.endsWith("/resume") && method === "POST") {
          const rest = pathname.slice("/api/tasks/".length, -"/resume".length);
          const taskId = decodeURIComponent(rest);
          const result = await handleTaskResume(app, taskId, await readBody(req, maxBodyBytes));
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname.startsWith("/api/tasks/") && method === "GET") {
          const taskId = decodeURIComponent(pathname.slice("/api/tasks/".length));
          const result = handleTaskGet(app, taskId);
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname.startsWith("/api/agent/runs/") && method === "GET") {
          const rest = decodeURIComponent(pathname.slice("/api/agent/runs/".length));
          if (rest.endsWith("/events")) {
            const runId = rest.slice(0, -"/events".length);
            handleActivityRunEvents(app, runId, res, req);
            return;
          }
          handleActivityRunGet(app, rest, res);
          return;
        }
        if (pathname === "/api/agent/stream" && method === "POST") {
          await handleAgentStream(app, await readBody(req, maxBodyBytes), res, req);
          return;
        }
        if (pathname === "/api/agent/resume" && method === "POST") {
          const result = await handleAgentResume(app, await readBody(req, maxBodyBytes));
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/agent" && method === "POST") {
          const result = await handleAgent(app, await readBody(req, maxBodyBytes));
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/runs" && method === "GET") {
          const result = handleRunsList(app, url);
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/runs/running" && method === "GET") {
          const result = handleRunsRunning(app);
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/runs/cancel" && method === "POST") {
          const result = handleRunCancel(app, await readBody(req, maxBodyBytes));
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/permission-requests/pending" && method === "GET") {
          const result = handlePermissionRequestsPending(app, url);
          sendJson(res, result.status, result.body);
          return;
        }
        const permissionRequestMatch = pathname.match(/^\/api\/permission-requests\/([^/]+)$/);
        if (permissionRequestMatch && method === "GET") {
          const requestId = decodeURIComponent(permissionRequestMatch[1]!);
          const result = handlePermissionRequestGet(app, requestId);
          sendJson(res, result.status, result.body);
          return;
        }
        const permissionRespondMatch = pathname.match(/^\/api\/permission-requests\/([^/]+)\/respond$/);
        if (permissionRespondMatch && method === "POST") {
          const result = handlePermissionRequestRespond(
            app,
            decodeURIComponent(permissionRespondMatch[1]!),
            await readBody(req, maxBodyBytes),
          );
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname.startsWith("/api/runs/") && method === "POST") {
          const rest = decodeURIComponent(pathname.slice("/api/runs/".length));
          if (rest.endsWith("/approve")) {
            const runId = rest.slice(0, -"/approve".length);
            const result = handleRunApprove(app, runId, await readBody(req, maxBodyBytes));
            sendJson(res, result.status, result.body);
            return;
          }
          if (rest.endsWith("/resume-permission")) {
            const runId = rest.slice(0, -"/resume-permission".length);
            const rawBody = (await readBody(req, maxBodyBytes)) as Record<string, unknown>;
            const result = await app.orchestrator.resumeAfterPermission(
              { ...rawBody, runId: rawBody.runId ?? runId },
              app.makeChatFn(),
            );
            sendJson(res, result.status, result.body);
            return;
          }
        }
        if (pathname.startsWith("/api/runs/") && method === "GET") {
          const rest = decodeURIComponent(pathname.slice("/api/runs/".length));
          if (rest.endsWith("/report")) {
            const id = rest.slice(0, -"/report".length);
            const result = await handleRunReport(app, id);
            sendJson(res, result.status, result.body);
            return;
          }
          const result = handleRunGet(app, rest);
          sendJson(res, result.status, result.body);
          return;
        }
        const runDeleteMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
        if (runDeleteMatch && method === "DELETE") {
          const result = handleRunDelete(app, decodeURIComponent(runDeleteMatch[1]!));
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/background" && method === "GET") {
          sendJson(res, 200, handleBackgroundList(app));
          return;
        }
        if (pathname === "/api/background/start" && method === "POST") {
          const result = handleBackgroundStart(app, await readBody(req, maxBodyBytes));
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/notifications" && method === "GET") {
          const pendingOnly = url.searchParams.get("pending") === "1";
          sendJson(res, 200, handleNotificationsList(app, pendingOnly));
          return;
        }
        if (pathname === "/api/notifications/consume" && method === "POST") {
          sendJson(res, 200, handleNotificationsConsume(app));
          return;
        }
        if (pathname === "/api/scheduler/triggers" && method === "GET") {
          sendJson(res, 200, handleSchedulerList(app));
          return;
        }
        if (pathname === "/api/scheduler/triggers" && method === "POST") {
          const result = handleSchedulerCreate(app, await readBody(req, maxBodyBytes));
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname.startsWith("/api/scheduler/triggers/")) {
          const rest = decodeURIComponent(pathname.slice("/api/scheduler/triggers/".length));
          if (rest.endsWith("/pause") && method === "POST") {
            const id = rest.slice(0, -"/pause".length);
            const result = handleSchedulerPause(app, id);
            sendJson(res, result.status, result.body);
            return;
          }
          if (rest.endsWith("/resume") && method === "POST") {
            const id = rest.slice(0, -"/resume".length);
            const result = handleSchedulerResume(app, id);
            sendJson(res, result.status, result.body);
            return;
          }
          if (rest.endsWith("/cancel") && method === "POST") {
            const id = rest.slice(0, -"/cancel".length);
            const result = handleSchedulerCancel(app, id);
            sendJson(res, result.status, result.body);
            return;
          }
        }
        if (pathname.startsWith("/api/background/") && pathname !== "/api/background/start") {
          const id = decodeURIComponent(pathname.slice("/api/background/".length));
          if (method === "GET") {
            const result = handleBackgroundGet(app, id);
            sendJson(res, result.status, result.body);
            return;
          }
          if (method === "POST" && id.endsWith("/cancel")) {
            const taskId = decodeURIComponent(id.slice(0, -"/cancel".length));
            const result = handleBackgroundCancel(app, taskId);
            sendJson(res, result.status, result.body);
            return;
          }
        }
        if (pathname === "/api/subagent/run" && method === "POST") {
          const result = await handleSubAgentRun(app, await readBody(req, maxBodyBytes));
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/subagent/batch" && method === "POST") {
          const result = await handleSubAgentBatch(app, await readBody(req, maxBodyBytes));
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/subagent/running" && method === "GET") {
          const result = handleSubAgentRunning(app);
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/subagent/schedule" && method === "GET") {
          const result = handleSubAgentSchedule(app);
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/subagent/cancel" && method === "POST") {
          const result = handleSubAgentCancel(app, await readBody(req, maxBodyBytes));
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/context/sessions" && method === "GET") {
          sendJson(res, 200, handleContextSessionsList(app));
          return;
        }
        if (pathname === "/api/context/sessions" && method === "POST") {
          const result = handleContextSessionCreate(app, await readBody(req, maxBodyBytes));
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/context/search" && method === "GET") {
          const result = await handleContextSearch(app, url);
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/context/project-index" && method === "GET") {
          const result = handleContextProjectIndex(app, url);
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/context/memories" && method === "GET") {
          const result = handleContextMemoriesList(app, url);
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/context/memories" && method === "POST") {
          const result = handleContextMemoryCreate(app, await readBody(req, maxBodyBytes));
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname.startsWith("/api/context/memories/")) {
          const rest = decodeURIComponent(pathname.slice("/api/context/memories/".length));
          if (rest.endsWith("/deactivate") && method === "POST") {
            const id = rest.slice(0, -"/deactivate".length);
            const result = handleContextMemoryDeactivate(app, id, await readBody(req, maxBodyBytes));
            sendJson(res, result.status, result.body);
            return;
          }
        }
        if (pathname.startsWith("/api/context/sessions/")) {
          const rest = decodeURIComponent(pathname.slice("/api/context/sessions/".length));
          if (rest.endsWith("/restore") && method === "GET") {
            const id = rest.slice(0, -"/restore".length);
            const phase =
              url.searchParams.get("phase") === "post_call" ? "post_call" : "pre_call";
            const result = await handleContextSessionRestore(
              app,
              id,
              url.searchParams.get("q") ?? undefined,
              phase,
            );
            sendJson(res, result.status, result.body);
            return;
          }
          if (rest.endsWith("/compress") && method === "POST") {
            const id = rest.slice(0, -"/compress".length);
            const result = await handleContextSessionCompress(app, id);
            sendJson(res, result.status, result.body);
            return;
          }
          if (rest.endsWith("/purge") && method === "POST") {
            const id = rest.slice(0, -"/purge".length);
            const result = handleContextSessionPurge(app, id, await readBody(req, maxBodyBytes));
            sendJson(res, result.status, result.body);
            return;
          }
          if (method === "PATCH" && rest) {
            const result = handleContextSessionUpdate(app, rest, await readBody(req, maxBodyBytes));
            sendJson(res, result.status, result.body);
            return;
          }
          if (method === "DELETE" && rest) {
            const result = handleContextSessionDeleteWithLifecycle(app, rest);
            sendJson(res, result.status, result.body);
            return;
          }
          if (method === "GET" && rest) {
            const result = handleContextSessionGet(app, rest);
            sendJson(res, result.status, result.body);
            return;
          }
        }
        if (pathname === "/api/tools" && method === "GET") {
          sendJson(res, 200, handleToolsList(app));
          return;
        }
        if (pathname === "/api/tools/run" && method === "POST") {
          const result = await handleToolRun(app, await readBody(req, maxBodyBytes));
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/docs" && method === "GET") {
          sendJson(res, 200, await handleDocsList(app));
          return;
        }
        if (pathname === "/api/docs/content" && method === "GET") {
          const result = await handleDocContent(app, url.searchParams.get("slug") ?? "");
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api-spec.json" && method === "GET") {
          await serveStatic(res, "/api-spec.json", app.paths.publicDir);
          return;
        }
        if (pathname === "/openapi.json" && method === "GET") {
          await serveStatic(res, "/api-spec.json", app.paths.publicDir);
          return;
        }
        if (pathname.startsWith("/api/")) {
          sendJson(res, 404, { error: "未知接口" });
          return;
        }
        if (pathname.startsWith("/docs-assets/") && method === "GET") {
          await serveDocsAsset(res, pathname, app.paths.docsAssetsDir);
          return;
        }
        if (pathname === "/docs" || pathname === "/docs/") {
          await serveStatic(res, "/docs.html", app.paths.publicDir);
          return;
        }
        if (pathname === "/api-docs" || pathname === "/api-docs/") {
          await serveStatic(res, "/api-docs.html", app.paths.publicDir);
          return;
        }
        if (pathname === "/favicon.ico" && method === "GET") {
          res.writeHead(204);
          res.end();
          return;
        }
        await serveStatic(res, pathname, app.paths.publicDir);
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(res, error.status, { error: error.message });
          return;
        }
        sendJson(res, 500, { error: String(error) });
      }
    })();
  });
}
