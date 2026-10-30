import { policyDb } from "./db";

export type AuditEvent = {
  actor: string;
  action: string;
  entityType: "submission" | "insured" | "quote" | "policy" | "book_policy" | "ledger";
  entityId: string;
  summary: string;
  before?: unknown;
  after?: unknown;
  correlationId?: string;
};

/** Append one row to policy.audit_events. Events from one user action share a correlation ID. */
export async function audit(...events: AuditEvent[]): Promise<void> {
  const correlationId = events[0]?.correlationId ?? crypto.randomUUID();
  for (const e of events) {
    await policyDb.query(
      `INSERT INTO audit_events (actor, action, entity_type, entity_id, summary, before, after, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [e.actor, e.action, e.entityType, e.entityId, e.summary,
       e.before === undefined ? null : JSON.stringify(e.before),
       e.after === undefined ? null : JSON.stringify(e.after),
       e.correlationId ?? correlationId],
    );
  }
}

export type AuditRow = {
  id: number; occurred_at: Date; actor: string; action: string; summary: string;
  before: unknown; after: unknown; correlation_id: string;
};

export async function auditTrail(entityType: string, entityId: string): Promise<AuditRow[]> {
  const { rows } = await policyDb.query<AuditRow>(
    "SELECT * FROM audit_events WHERE entity_type = $1 AND entity_id = $2 ORDER BY id DESC",
    [entityType, entityId],
  );
  return rows;
}
