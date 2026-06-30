/**
 * Ensures npm test either runs every test file or explicitly documents why it is skipped.
 * Run: npm run test:package-test-coverage
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const explicitAllowlist = new Set([
  "activity-timeline.test.ts",
  "agent-outcome-e2e.test.ts",
  "ai-intent-classifier.test.ts",
  "anthropic-client.test.ts",
  "apply-prompt-strategy-messages.test.ts",
  "context-analyzer.test.ts",
  "continuation-detector.test.ts",
  "cost-budget-manager.test.ts",
  "data-lifecycle-retention.test.ts",
  "implicit-plan-workflow.test.ts",
  "intent-router.test.ts",
  "message-envelope.test.ts",
  "model-availability.test.ts",
  "model-capability-profile.test.ts",
  "model-profile-store.test.ts",
  "plan-activation.test.ts",
  "plan-compiler.test.ts",
  "plan-dag-builder.test.ts",
  "plan-report-enrichment.test.ts",
  "plan-tool-binder.test.ts",
  "project-index.test.ts",
  "prompt-strategy.test.ts",
  "refactor-plan-workflow.test.ts",
  "repro-stream-length.test.ts",
  "router-context-estimate.test.ts",
  "run-state-location.test.ts",
  "run-state-store.test.ts",
  "runtime-stats-feedback.test.ts",
  "smart-chat-redact.test.ts",
  "smart-chat-stream.test.ts",
  "subagent-execution-router.test.ts",
  "subagent-queue-gate.test.ts",
  "tool-result-layers.test.ts",
  "workflow-correction-workflow.test.ts",
  "workflow-planner.test.ts",
  "workspace-catalog.test.ts",
]);

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf-8")) as {
  scripts?: Record<string, string>;
};
const npmTest = packageJson.scripts?.test ?? "";
const files = (await readdir(path.join(root, "tests"))).filter((file) => file.endsWith(".test.ts")).sort();
const unaccounted = files.filter((file) => !npmTest.includes(`tests/${file}`) && !explicitAllowlist.has(file));
const staleAllowlist = [...explicitAllowlist].filter((file) => !files.includes(file));

assert.deepEqual(staleAllowlist, [], "package-test-coverage allowlist contains stale files");
assert.deepEqual(unaccounted, [], "tests must be included in npm test or explicitAllowlist");

console.log(`package-test-coverage: ${files.length - explicitAllowlist.size}/${files.length} test files in npm test`);
