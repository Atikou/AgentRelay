import type { DatabaseSync } from "node:sqlite";

import { inferEnvelopeFromLegacy } from "./messageEnvelope.js";
import {
  parseRunResultJson,
  runFactsIndicateTrustedCompletion,
  type RunExecutionFacts,
} from "./runFactsLookup.js";

/** 为无 message_kind 的旧消息回填 envelope；带 runId 的可升级为 trusted。 */
export function backfillMessageEnvelopes(db: DatabaseSync): number {
  let updated = 0;

  db.exec(`
    UPDATE messages
    SET message_kind = 'user_input', trusted = 1, source = 'user', ui_visible = 1
    WHERE role = 'user' AND (message_kind IS NULL OR message_kind = '');
  `);
  db.exec(`
    UPDATE messages
    SET message_kind = 'tool_result', trusted = 1, source = 'tool', ui_visible = 0
    WHERE role = 'tool' AND (message_kind IS NULL OR message_kind = '');
  `);
  db.exec(`
    UPDATE messages
    SET message_kind = 'workflow_event', trusted = 0, source = 'workflow', ui_visible = 0
    WHERE role = 'system' AND (message_kind IS NULL OR message_kind = '');
  `);
  db.exec(`
    UPDATE messages
    SET message_kind = 'tool_action', trusted = 0, source = 'model', ui_visible = 0
    WHERE role = 'assistant'
      AND (message_kind IS NULL OR message_kind = '')
      AND content LIKE '{"action":"tool"%';
  `);
  db.exec(`
    UPDATE messages
    SET message_kind = 'raw_model_final', trusted = 0, source = 'model', ui_visible = 0
    WHERE role = 'assistant'
      AND (message_kind IS NULL OR message_kind = '')
      AND content LIKE '{"action":"final"%';
  `);
  db.exec(`
    UPDATE messages
    SET message_kind = 'final_answer', trusted = 0, source = 'model', ui_visible = 0
    WHERE role = 'assistant' AND (message_kind IS NULL OR message_kind = '');
  `);

  const stmt = db.prepare(`
    UPDATE messages
    SET message_kind = ?, ui_visible = ?, trusted = ?, source = ?
    WHERE id = ?
  `);

  const pending = db
    .prepare(
      `SELECT id, role, content, message_kind, trusted, run_id
       FROM messages
       WHERE role = 'assistant' AND run_id IS NOT NULL AND trusted = 0
         AND message_kind IN ('final_answer', 'raw_model_final')`,
    )
    .all() as Array<{
      id: string;
      role: string;
      content: string;
      message_kind: string | null;
      trusted: number;
      run_id: string | null;
    }>;

  for (const row of pending) {
    const facts = loadRunFacts(db, row.run_id!);
    if (!facts || !runFactsIndicateTrustedCompletion(facts)) continue;
    const envelope = inferEnvelopeFromLegacy(row.role, row.content);
    stmt.run(
      "final_answer",
      1,
      1,
      envelope.source === "guard" ? "guard" : "model",
      row.id,
    );
    updated += 1;
  }

  return updated;
}

function loadRunFacts(db: DatabaseSync, runId: string): RunExecutionFacts | null {
  const row = db
    .prepare(`SELECT id, goal, status, result_json FROM runs WHERE id = ?`)
    .get(runId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const parsed = parseRunResultJson(row.result_json ? String(row.result_json) : undefined);
  const meta = parsed?.executionMeta;
  const toolLedger = meta?.toolLedger as RunExecutionFacts["toolLedger"];
  return {
    runId: String(row.id),
    goal: row.goal ? String(row.goal) : undefined,
    status: row.status ? String(row.status) : undefined,
    completionStatus: meta?.completionStatus ? String(meta.completionStatus) : undefined,
    stopReason: meta?.stopReason ? String(meta.stopReason) : undefined,
    toolLedger,
  };
}
