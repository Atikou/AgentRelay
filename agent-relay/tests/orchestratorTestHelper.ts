import { AgentRunRegistry } from "../src/orchestrator/AgentRunRegistry.js";
import { Orchestrator, type OrchestratorDeps } from "../src/orchestrator/Orchestrator.js";

/** 测试用 Orchestrator 工厂：自动注入 `AgentRunRegistry`。 */
export function createTestOrchestrator(
  deps: Omit<OrchestratorDeps, "agentRunRegistry"> & { agentRunRegistry?: AgentRunRegistry },
): { orchestrator: Orchestrator; agentRunRegistry: AgentRunRegistry } {
  const agentRunRegistry = deps.agentRunRegistry ?? new AgentRunRegistry();
  const orchestrator = new Orchestrator({ ...deps, agentRunRegistry });
  return { orchestrator, agentRunRegistry };
}
