import type { AgentIntentType } from "./IntentTypes.js";
import type { UserPermissionPolicy } from "./RunPolicyTypes.js";

export interface EditProposalWorkflowInput {
  goal: string;
  intent: AgentIntentType;
  permissionPolicy: UserPermissionPolicy;
}

export interface EditProposalWorkflowResult {
  modelContext: string;
}

/**
 * Adds the proposal phase for write-oriented workflows.
 *
 * This workflow does not write files. It gives the model a deterministic contract for the
 * next phase so edit/generate-file requests do not jump from location directly to mutation.
 */
export class EditProposalWorkflow {
  run(input: EditProposalWorkflowInput): EditProposalWorkflowResult | undefined {
    if (input.intent !== "edit" && input.intent !== "generate_file") return undefined;
    return {
      modelContext: renderEditProposalContext(input),
    };
  }
}

function renderEditProposalContext(input: EditProposalWorkflowInput): string {
  const workflowName = input.intent === "generate_file" ? "generateFileWorkflow" : "editWorkflow";
  const actionName = input.intent === "generate_file" ? "create-file" : "edit";
  return [
    `${workflowName} proposal phase:`,
    `goal: ${input.goal}`,
    `permissionPolicy: ${input.permissionPolicy}`,
    "",
    "Before any write-capable tool call, form a concrete modification proposal from the located context.",
    "The proposal must cover:",
    "1. targetFiles: exact files or directories to create/update.",
    "2. changeSummary: the intended change in one or two sentences.",
    "3. permissionCheck: whether the current permission policy allows the next write-capable tool, and whether confirmation may be required.",
    "4. diffPlan: the expected patch shape or file creation plan before applying it.",
    "5. verificationPlan: the smallest useful check after the change.",
    "",
    `If the proposal is not concrete enough for ${actionName}, keep using read tools. If no write is needed, return final instead of calling write tools.`,
  ].join("\n");
}
