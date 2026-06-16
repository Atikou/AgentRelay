/**
 * 轻量测试台后端：用 Node 内置 http 暴露当前已实现的 Agent 能力，供网页测试。
 *
 * 启动：npm run serve  （默认 http://localhost:18787）
 * 仅依赖标准库，不引入 Web 框架。
 */
import { createAppContext } from "../app/createAppContext.js";
import { loadEnvFile } from "../util/env.js";
import { createHttpServer } from "./createHttpServer.js";

loadEnvFile();

const PORT = Number(process.env.PORT ?? 18787);
const HOST = process.env.HOST ?? process.env.AGENT_RELAY_HOST ?? "127.0.0.1";

const app = createAppContext();
const server = createHttpServer(app);

server.listen(PORT, HOST, () => {
  console.log(`测试台已启动：http://${HOST}:${PORT}  (profile=${app.profile})`);
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  try {
    await app.shutdown();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
