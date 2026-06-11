import type { ModelClientConfig, ModelProvider } from "../config/types.js";
import { withTimeout } from "../util/timeout.js";

const PROBE_TIMEOUT_MS = 8_000;

export interface ModelCatalogEntry {
  clientName: string;
  provider: ModelProvider;
  baseUrl: string;
  configuredModel: string;
  reachable: boolean;
  /** 端点返回的已安装/已加载模型 id 列表（去重排序）。 */
  models: string[];
  /** 配置的 model 是否出现在 models 中（Ollama 支持 tag 前缀匹配）。 */
  configuredModelInstalled?: boolean;
  error?: string;
}

function resolveApiKey(config: ModelClientConfig): string | undefined {
  if (config.apiKeyEnv) {
    const fromEnv = process.env[config.apiKeyEnv];
    if (fromEnv && fromEnv.length > 0) return fromEnv;
  }
  return config.apiKey;
}

export function parseOllamaTagNames(data: { models?: Array<{ name?: string; model?: string }> }): string[] {
  const names = (data.models ?? [])
    .map((m) => m.name ?? m.model ?? "")
    .filter((n) => n.length > 0);
  return [...new Set(names)].sort();
}

export function parseOpenAiModelIds(data: { data?: Array<{ id?: string }> }): string[] {
  const ids = (data.data ?? []).map((m) => m.id ?? "").filter((id) => id.length > 0);
  return [...new Set(ids)].sort();
}

export function isConfiguredModelInstalled(configured: string, available: string[]): boolean {
  if (available.length === 0) return false;
  return available.some((name) => name === configured || name.startsWith(`${configured}:`));
}

async function probeOllamaCatalog(baseUrl: string): Promise<{ models: string[]; error?: string }> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/tags`;
  const { signal, cancel } = withTimeout(PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      return { models: [], error: `HTTP ${response.status}` };
    }
    const data = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
    return { models: parseOllamaTagNames(data) };
  } catch (error) {
    return { models: [], error: String(error) };
  } finally {
    cancel();
  }
}

async function probeOpenAiCompatibleCatalog(
  baseUrl: string,
  apiKey?: string,
): Promise<{ models: string[]; error?: string }> {
  const root = baseUrl.replace(/\/$/, "");
  const url = root.endsWith("/v1") ? `${root}/models` : `${root}/v1/models`;
  const { signal, cancel } = withTimeout(PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal,
      headers: {
        Authorization: `Bearer ${apiKey && apiKey.length > 0 ? apiKey : "not-needed"}`,
      },
    });
    if (!response.ok) {
      return { models: [], error: `HTTP ${response.status}` };
    }
    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    return { models: parseOpenAiModelIds(data) };
  } catch (error) {
    return { models: [], error: String(error) };
  } finally {
    cancel();
  }
}

/** 探测配置中本地客户端对应端点的已安装模型列表（不修改配置）。 */
export async function listLocalModelCatalog(
  clients: ModelClientConfig[],
): Promise<ModelCatalogEntry[]> {
  const localClients = clients.filter((c) => c.location === "local");
  const entries = await Promise.all(
    localClients.map(async (c) => {
      let models: string[] = [];
      let error: string | undefined;

      if (c.provider === "ollama") {
        const result = await probeOllamaCatalog(c.baseUrl);
        models = result.models;
        error = result.error;
      } else if (c.provider === "openai-compatible") {
        const result = await probeOpenAiCompatibleCatalog(c.baseUrl, resolveApiKey(c));
        models = result.models;
        error = result.error;
      } else {
        error = `${c.provider} 本地目录探测暂未支持`;
      }

      const reachable = error === undefined;
      return {
        clientName: c.name,
        provider: c.provider,
        baseUrl: c.baseUrl,
        configuredModel: c.model,
        reachable,
        models,
        configuredModelInstalled:
          models.length > 0 ? isConfiguredModelInstalled(c.model, models) : undefined,
        ...(error ? { error } : {}),
      } satisfies ModelCatalogEntry;
    }),
  );
  return entries;
}
