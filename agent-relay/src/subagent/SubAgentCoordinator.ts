import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { aggregateSubAgentResultsStructured, SubAgentRunner, type SubAgentRunnerDeps } from "./SubAgentRunner.js";
import type { SubAgentBatchOptions, SubAgentBatchResult, SubAgentRoleId, SubAgentRunOptions, SubAgentRunResult } from "./types.js";

/** 并行派生多个只读子 Agent 并汇总结果（M5）。 */
export class SubAgentCoordinator {
  private readonly runner: SubAgentRunner;

  constructor(deps: SubAgentRunnerDeps) {
    this.runner = new SubAgentRunner(deps);
  }

  run(options: SubAgentRunOptions): Promise<SubAgentRunResult> {
    return this.runner.run(options);
  }

  async runBatch(options: SubAgentBatchOptions): Promise<SubAgentBatchResult> {
    const parentTaskId = options.parentTaskId ?? randomUUID();
    const roles = dedupeRoles(options.roles);
    if (roles.length === 0) {
      throw new Error("roles 不能为空");
    }

    const start = performance.now();
    const settled = await Promise.all(
      roles.map((role) =>
        this.runner.run({
          role,
          task: options.task,
          context: options.context,
          parentTaskId,
          grantedPermissions: options.grantedPermissions,
          budget: options.budget,
          timeoutMs: options.timeoutMs,
          sensitive: options.sensitive,
        }),
      ),
    );

    const aggregate = aggregateSubAgentResultsStructured(settled);
    return {
      parentTaskId,
      results: settled,
      summary: aggregate.mergedAnswer,
      aggregate,
      durationMs: Math.round(performance.now() - start),
    };
  }
}

function dedupeRoles(roles: SubAgentRoleId[]): SubAgentRoleId[] {
  return [...new Set(roles)];
}
