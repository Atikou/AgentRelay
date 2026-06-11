import { createServer, type Server } from "node:http";

import type { AppContext } from "../app/createAppContext.js";
import {
  handleAgent,
  handleAgentStream,
  handleChat,
  handlePlan,
  handleTaskDryRun,
  handleTaskRun,
} from "./handlers/agent.handlers.js";
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
  handleContextSearch,
  handleContextSessionCompress,
  handleContextSessionCreate,
  handleContextSessionGet,
  handleContextSessionRestore,
  handleContextSessionsList,
} from "./handlers/context.handlers.js";
import { handleDocContent, handleDocsList } from "./handlers/docs.handlers.js";
import { handleRunGet, handleRunsList } from "./handlers/runs.handlers.js";
import {
  handleSchedulerCancel,
  handleSchedulerCreate,
  handleSchedulerList,
  handleSchedulerPause,
  handleSchedulerResume,
} from "./handlers/scheduler.handlers.js";
import { handleSubAgentBatch, handleSubAgentRoles, handleSubAgentRun } from "./handlers/subagent.handlers.js";
import { handleToolsList, handleToolRun } from "./handlers/tools.handlers.js";
import { handleTraceExport, handleTraceRecent, handleTraceReplay } from "./handlers/trace.handlers.js";
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
        if (pathname === "/api/chat" && method === "POST") {
          const result = await handleChat(app, await readBody(req, maxBodyBytes));
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/metrics" && method === "GET") {
          sendJson(res, 200, metrics(app));
          return;
        }
        if (pathname === "/api/trace/recent" && method === "GET") {
          const result = handleTraceRecent(app, url);
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/trace/export" && method === "GET") {
          const result = handleTraceExport(app, url);
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/trace/replay" && method === "GET") {
          const result = handleTraceReplay(app, url);
          sendJson(res, result.status, result.body);
          return;
        }
        if (pathname === "/api/plan" && method === "POST") {
          const result = await handlePlan(app, await readBody(req, maxBodyBytes));
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
        if (pathname === "/api/agent/stream" && method === "POST") {
          await handleAgentStream(app, await readBody(req, maxBodyBytes), res);
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
        if (pathname.startsWith("/api/runs/") && method === "GET") {
          const id = decodeURIComponent(pathname.slice("/api/runs/".length));
          const result = handleRunGet(app, id);
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
        if (pathname === "/api/subagent/roles" && method === "GET") {
          sendJson(res, 200, handleSubAgentRoles());
          return;
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
