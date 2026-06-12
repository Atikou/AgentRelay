import {
  PlanApprovalManager,
  PlanService,
  PlanStore,
  PlanValidator,
} from "../src/plan/index.js";
import type { ContextManager } from "../src/context/ContextManager.js";
import type { ToolRegistry } from "../src/tools/ToolRegistry.js";
import type { TraceLogger } from "../src/trace/TraceLogger.js";

export function createTestPlanService(input: {
  workspaceRoot: string;
  db: ContextManager["db"];
  registry: ToolRegistry;
  trace?: TraceLogger;
}): PlanService {
  const store = new PlanStore(input.db);
  const validator = new PlanValidator({
    workspaceRoot: input.workspaceRoot,
    registry: input.registry,
  });
  const approval = new PlanApprovalManager(store);
  return new PlanService({
    workspaceRoot: input.workspaceRoot,
    store,
    validator,
    approval,
    registry: input.registry,
    trace: input.trace,
  });
}
