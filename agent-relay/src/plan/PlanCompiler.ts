import { finalizePlan } from "../agent/taskGraph.js";
import type { Plan, PlanStep } from "../agent/types.js";
import type { ToolPermission } from "../agent/permissions.js";
import type { UserVisiblePlan, UserVisibleTodo } from "./types.js";

export interface CompileUserVisiblePlanInput {
  userVisiblePlan: UserVisiblePlan;
  confirmedTodoIds: string[];
}

export class PlanCompiler {
  compile(input: CompileUserVisiblePlanInput): Plan {
    const selected = selectTodos(input.userVisiblePlan.todos, input.confirmedTodoIds);
    if (selected.length === 0) {
      throw new Error("confirmedTodoIds 至少需要命中一条 UserVisibleTodo");
    }

    const steps: PlanStep[] = selected.map((todo, index) => ({
      id: todo.id,
      title: todo.title,
      objective: todo.goal,
      description: todo.implementationIdea,
      requiredPermissions: inferPermissions(todo),
      needsConfirmation: todo.requiresUserConfirmation || todo.riskLevel !== "low",
      acceptance: todo.acceptanceCriteria.join("；"),
      dependsOn: index === 0 ? [] : [selected[index - 1]!.id],
      requiredContext: todo.relatedFiles ?? [],
      availableTools: ["read_file", "search_text", "apply_patch", "git_diff"],
      expectedArtifacts: todo.acceptanceCriteria,
      priority: priorityNumber(todo.priority, index),
      status: "pending",
    }));

    return finalizePlan({
      goal: input.userVisiblePlan.title,
      scope: {
        inScope: selected.map((t) => t.title),
        outOfScope: ["未确认的 Todo", "UserVisiblePlan Markdown 原文直接执行"],
      },
      inputs: [`UserVisiblePlan:${input.userVisiblePlan.id}`],
      outputs: ["待审批 ExecutableTaskPlan 草案"],
      acceptanceCriteria: selected.flatMap((t) => t.acceptanceCriteria),
      risks: input.userVisiblePlan.risks.map((r) => r.title),
      dependencies: ["用户确认 Todo 范围", "PlanValidator 校验", "PlanStore 持久化"],
      steps,
    });
  }
}

function selectTodos(todos: UserVisibleTodo[], ids: string[]): UserVisibleTodo[] {
  const selectedIds = new Set(ids);
  return todos.filter((todo) => selectedIds.has(todo.id));
}

function inferPermissions(todo: UserVisibleTodo): ToolPermission[] {
  if (!todo.allowAutoImplement) return ["read"];
  if (todo.riskLevel === "high") return ["read", "write", "shell"];
  if (todo.riskLevel === "medium") return ["read", "write"];
  return ["read"];
}

function priorityNumber(priority: UserVisibleTodo["priority"], index: number): number {
  const base = { P0: 0, P1: 100, P2: 200, P3: 300 }[priority];
  return base + index;
}
