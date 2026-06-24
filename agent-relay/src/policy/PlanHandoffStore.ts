import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  PLAN_HANDOFF_SCHEMA_VERSION,
  type PlanHandoffDecision,
  type PlanHandoffPayload,
  type PlanHandoffRespondInput,
  type PlanHandoffVariant,
} from "./planHandoffTypes.js";

export interface CreatePlanHandoffInput {
  runId: string;
  sessionId?: string;
  planMarkdown: string;
  planVariant: PlanHandoffVariant;
  message: string;
  resumeMode?: "implement";
}

export class PlanHandoffStore {
  private readonly handoffs = new Map<string, PlanHandoffPayload>();
  private readonly byRunId = new Map<string, string>();

  constructor(private readonly db?: DatabaseSync) {}

  create(input: CreatePlanHandoffInput): PlanHandoffPayload {
    if (this.db) {
      const existing = this.getPendingByRunId(input.runId);
      if (existing) return existing;

      const payload = this.buildPayload(input);
      this.db
        .prepare(
          `INSERT INTO plan_handoffs
           (id, plan_id, run_id, session_id, status, payload_json, created_at, updated_at, responded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          payload.id,
          payload.planId,
          payload.runId,
          payload.sessionId ?? null,
          payload.status,
          JSON.stringify(payload),
          payload.createdAt,
          payload.createdAt,
          null,
        );
      return payload;
    }

    const existingId = this.byRunId.get(input.runId);
    if (existingId) {
      const existing = this.handoffs.get(existingId);
      if (existing?.status === "pending") return existing;
    }

    const payload = this.buildPayload(input);
    this.handoffs.set(payload.id, payload);
    this.byRunId.set(input.runId, payload.id);
    return payload;
  }

  private buildPayload(input: CreatePlanHandoffInput): PlanHandoffPayload {
    const id = randomUUID();
    return {
      schemaVersion: PLAN_HANDOFF_SCHEMA_VERSION,
      id,
      planId: id,
      runId: input.runId,
      sessionId: input.sessionId,
      status: "pending",
      resumeMode: input.resumeMode ?? "implement",
      message: input.message,
      planVariant: input.planVariant,
      planMarkdown: input.planMarkdown,
      createdAt: new Date().toISOString(),
    };
  }

  get(id: string): PlanHandoffPayload | null {
    if (this.db) {
      const row = this.db
        .prepare(`SELECT payload_json FROM plan_handoffs WHERE id=?`)
        .get(id) as { payload_json: string } | undefined;
      return this.parsePayload(row);
    }
    return this.handoffs.get(id) ?? null;
  }

  getPendingByRunId(runId: string): PlanHandoffPayload | null {
    if (this.db) {
      const row = this.db
        .prepare(
          `SELECT payload_json FROM plan_handoffs
           WHERE run_id=? AND status='pending'
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(runId) as { payload_json: string } | undefined;
      return this.parsePayload(row);
    }

    const id = this.byRunId.get(runId);
    if (!id) return null;
    const handoff = this.handoffs.get(id);
    if (!handoff || handoff.status !== "pending") return null;
    return handoff;
  }

  getApprovedByRunId(runId: string): PlanHandoffPayload | null {
    if (this.db) {
      const row = this.db
        .prepare(
          `SELECT payload_json FROM plan_handoffs
           WHERE run_id=? AND status='approved'
           ORDER BY responded_at DESC
           LIMIT 1`,
        )
        .get(runId) as { payload_json: string } | undefined;
      return this.parsePayload(row);
    }

    const id = this.byRunId.get(runId);
    if (!id) return null;
    const handoff = this.handoffs.get(id);
    if (!handoff || handoff.status !== "approved") return null;
    return handoff;
  }

  getPendingBySessionId(sessionId: string): PlanHandoffPayload | null {
    const sid = sessionId.trim();
    if (!sid) return null;

    if (this.db) {
      const row = this.db
        .prepare(
          `SELECT payload_json FROM plan_handoffs
           WHERE session_id=? AND status='pending'
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(sid) as { payload_json: string } | undefined;
      return this.parsePayload(row);
    }

    for (const handoff of this.handoffs.values()) {
      if (handoff.sessionId === sid && handoff.status === "pending") return handoff;
    }
    return null;
  }

  listPending(input?: { sessionId?: string; runId?: string }): PlanHandoffPayload[] {
    if (this.db) {
      const sessionId = input?.sessionId?.trim();
      const runId = input?.runId?.trim();
      let rows: { payload_json: string }[];
      if (sessionId) {
        rows = this.db
          .prepare(
            `SELECT payload_json FROM plan_handoffs
             WHERE session_id=? AND status='pending'
             ORDER BY updated_at DESC`,
          )
          .all(sessionId) as { payload_json: string }[];
      } else if (runId) {
        rows = this.db
          .prepare(
            `SELECT payload_json FROM plan_handoffs
             WHERE run_id=? AND status='pending'
             ORDER BY updated_at DESC`,
          )
          .all(runId) as { payload_json: string }[];
      } else {
        rows = this.db
          .prepare(
            `SELECT payload_json FROM plan_handoffs
             WHERE status='pending'
             ORDER BY updated_at DESC`,
          )
          .all() as { payload_json: string }[];
      }
      return rows.map((row) => JSON.parse(row.payload_json) as PlanHandoffPayload);
    }

    return [...this.handoffs.values()].filter((h) => {
      if (h.status !== "pending") return false;
      if (input?.sessionId && h.sessionId !== input.sessionId.trim()) return false;
      if (input?.runId && h.runId !== input.runId.trim()) return false;
      return true;
    });
  }

  respond(id: string, input: PlanHandoffRespondInput): PlanHandoffPayload | null {
    const handoff = this.get(id);
    if (!handoff || handoff.status !== "pending") return null;

    const respondedAt = new Date().toISOString();
    const updated: PlanHandoffPayload = {
      ...handoff,
      status: input.decision === "approve" ? "approved" : "rejected",
      decision: input.decision,
      respondedAt,
    };

    if (this.db) {
      this.db
        .prepare(
          `UPDATE plan_handoffs
           SET status=?, payload_json=?, updated_at=?, responded_at=?
           WHERE id=?`,
        )
        .run(updated.status, JSON.stringify(updated), respondedAt, respondedAt, id);
    } else {
      this.handoffs.set(id, updated);
    }
    return updated;
  }

  deleteByRunId(runId: string): void {
    if (this.db) {
      this.db.prepare(`DELETE FROM plan_handoffs WHERE run_id=?`).run(runId);
      return;
    }
    const id = this.byRunId.get(runId);
    if (id) {
      this.handoffs.delete(id);
      this.byRunId.delete(runId);
    }
  }

  private parsePayload(row: { payload_json: string } | undefined): PlanHandoffPayload | null {
    if (!row?.payload_json) return null;
    try {
      return JSON.parse(row.payload_json) as PlanHandoffPayload;
    } catch {
      return null;
    }
  }
}

export const defaultPlanHandoffStore = new PlanHandoffStore();
