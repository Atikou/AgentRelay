import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AppConfigSchema, type AppConfig } from "./types.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
/** 项目根：dist/.. 或 src/.. 都退到 agent-relay（可运行代码）根目录。 */
const projectRoot = path.resolve(moduleDir, "..", "..");

export interface LoadConfigOptions {
  /** profile 名（对应 config/<profile>.json）。默认读 AGENT_PROFILE 或 "default"。 */
  profile?: string;
}

export interface LoadedConfig {
  profile: string;
  config: AppConfig;
  /** 已解析为绝对路径的工作区根。 */
  workspaceRoot: string;
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const profile = options.profile ?? process.env.AGENT_PROFILE ?? "default";
  const configPath = path.join(projectRoot, "config", `${profile}.json`);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (error) {
    throw new Error(`无法读取配置文件 ${configPath}：${String(error)}`);
  }

  const parsed = AppConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`配置文件校验失败 ${configPath}：\n${parsed.error.toString()}`);
  }

  const config = parsed.data;
  const workspaceRoot = path.resolve(projectRoot, config.workspaceRoot);

  return { profile, config, workspaceRoot };
}
