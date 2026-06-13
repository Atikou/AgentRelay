import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";

export type AgentWorkflowExecutor =
  | "answerExecutor"
  | "planExecutor"
  | "editExecutor"
  | "runExecutor"
  | "debugExecutor"
  | "reviewExecutor"
  | "verifyExecutor"
  | "summarizeExecutor"
  | "searchExecutor"
  | "refactorExecutor"
  | "generateFileExecutor";

export interface WorkflowRouteInput {
  intent: AgentIntentType;
}

export interface WorkflowRouteResult {
  intent: AgentIntentType;
  workflowType: AgentWorkflowType;
  executor: AgentWorkflowExecutor;
  readonlyOnly: boolean;
  sideEffectKind: "none" | "write" | "shell" | "mixed";
}

const WORKFLOW_ROUTES: Record<AgentIntentType, Omit<WorkflowRouteResult, "intent">> = {
  answer: {
    workflowType: "answerWorkflow",
    executor: "answerExecutor",
    readonlyOnly: true,
    sideEffectKind: "none",
  },
  plan: {
    workflowType: "planWorkflow",
    executor: "planExecutor",
    readonlyOnly: true,
    sideEffectKind: "none",
  },
  edit: {
    workflowType: "editWorkflow",
    executor: "editExecutor",
    readonlyOnly: false,
    sideEffectKind: "write",
  },
  run: {
    workflowType: "runWorkflow",
    executor: "runExecutor",
    readonlyOnly: false,
    sideEffectKind: "shell",
  },
  debug: {
    workflowType: "debugWorkflow",
    executor: "debugExecutor",
    readonlyOnly: false,
    sideEffectKind: "mixed",
  },
  review: {
    workflowType: "reviewWorkflow",
    executor: "reviewExecutor",
    readonlyOnly: true,
    sideEffectKind: "none",
  },
  verify: {
    workflowType: "verifyWorkflow",
    executor: "verifyExecutor",
    readonlyOnly: false,
    sideEffectKind: "shell",
  },
  summarize: {
    workflowType: "summarizeWorkflow",
    executor: "summarizeExecutor",
    readonlyOnly: true,
    sideEffectKind: "none",
  },
  search: {
    workflowType: "searchWorkflow",
    executor: "searchExecutor",
    readonlyOnly: true,
    sideEffectKind: "none",
  },
  refactor: {
    workflowType: "refactorWorkflow",
    executor: "refactorExecutor",
    readonlyOnly: false,
    sideEffectKind: "write",
  },
  generate_file: {
    workflowType: "generateFileWorkflow",
    executor: "generateFileExecutor",
    readonlyOnly: false,
    sideEffectKind: "write",
  },
};

export class WorkflowRouter {
  route(input: WorkflowRouteInput): WorkflowRouteResult {
    return this.routeIntent(input.intent);
  }

  routeIntent(intent: AgentIntentType): WorkflowRouteResult {
    const route = WORKFLOW_ROUTES[intent];
    return { intent, ...route };
  }
}

export const defaultWorkflowRouter = new WorkflowRouter();

