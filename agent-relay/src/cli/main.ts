/**
 * 主入口（M1 将扩展为完整的 Agent 对话循环）。
 * 目前仅完成框架接线：加载配置 + 构建模型客户端，验证「模型接入」是否就绪。
 */
import { loadConfig } from "../config/loadConfig.js";
import { createModelClients } from "../model/ModelFactory.js";
import { loadEnvFile } from "../util/env.js";

loadEnvFile();

async function main(): Promise<void> {
  const { profile, config } = loadConfig();
  const clients = createModelClients(config.models.clients);

  console.log(`Agent 框架已就绪（profile=${profile}）。`);
  console.log(`已注册 ${clients.length} 个模型客户端：`);
  for (const client of clients) {
    console.log(`  - ${client.name}（${client.location} / ${client.model}）`);
  }
  console.log("\n后续里程碑：M1 对话循环、工具系统、计划/任务模式、模型路由（自主选择）。");
  console.log("可先运行 `npm run models:check` 验证本地/远程模型连通性。");
}

main().catch((error) => {
  console.error("启动失败：", error);
  process.exitCode = 1;
});
