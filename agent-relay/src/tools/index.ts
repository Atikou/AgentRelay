import type { TraceLogger } from "../trace/TraceLogger.js";
import { readFileTool, listFilesTool, searchTextTool, writeFileTool } from "./fileTools.js";
import { shellRunTool } from "./shellTool.js";
import { ToolRegistry } from "./ToolRegistry.js";

export * from "./types.js";
export { resolveInsideWorkspace } from "./pathSafe.js";
export { checkCommandRisk, type RiskLevel, type RiskVerdict } from "./risk.js";
export { readFileTool, listFilesTool, searchTextTool, writeFileTool } from "./fileTools.js";
export { shellRunTool } from "./shellTool.js";
export { ToolRegistry, type RegistryRunContext } from "./ToolRegistry.js";

/** 内置工具集合。 */
export const BUILTIN_TOOLS = [
  readFileTool,
  listFilesTool,
  searchTextTool,
  writeFileTool,
  shellRunTool,
];

/** 创建包含全部内置工具的注册表。 */
export function createDefaultRegistry(trace?: TraceLogger): ToolRegistry {
  const registry = new ToolRegistry(trace);
  for (const tool of BUILTIN_TOOLS) {
    registry.register(tool);
  }
  return registry;
}
