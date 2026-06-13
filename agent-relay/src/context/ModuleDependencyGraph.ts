import type { ProjectIndex } from "./ProjectIndex.js";

export type GraphRelation = "imports" | "imported_by";

export interface GraphNeighbor {
  path: string;
  relation: GraphRelation;
  depth: number;
}

/** 基于 ProjectIndex 持久化 import 边的模块依赖图查询。 */
export class ModuleDependencyGraph {
  constructor(private readonly index: ProjectIndex) {}

  getDependencies(projectId: string, workspaceRoot: string, filePath: string): string[] {
    return this.index.getDependencies(projectId, workspaceRoot, filePath);
  }

  getDependents(projectId: string, workspaceRoot: string, filePath: string): string[] {
    return this.index.getDependents(projectId, workspaceRoot, filePath);
  }

  expandNeighbors(
    projectId: string,
    workspaceRoot: string,
    seeds: string[],
    options?: { maxDepth?: number; limit?: number },
  ): GraphNeighbor[] {
    return this.index.expandGraphNeighbors(projectId, workspaceRoot, seeds, options);
  }
}
