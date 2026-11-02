import { policyDb, type Queryable } from "./db";

export type AuditEvent = {
  actor: string;
  action: string;
  entityType: "submission" | "insured" | "quote" | "policy" | "book_policy" | "ledger";
  entityId: string;
  summary: string;
  before?: unknown;
  after?: unknown;
  correlationId?: string;
  occurredAt?: Date;   // when it happened, if not now (seeded history); the database stamps recorded_at itself (CR-074)
};

/**
 * Append one row per event to policy.audit_events. Events from one user action share a correlation
 * ID. Pass the events as an array plus a client to write them inside that client's transaction
 * (so the audit row commits or rolls back with the change it describes).
 */
export async function audit(...args: AuditEvent[] | [AuditEvent[], Queryable]): Promise<void> {
  const [events, db]: [AuditEvent[], Queryable] = Array.isArray(args[0]) ? [args[0], args[1] as Queryable] : [args as AuditEvent[], policyDb];
  const correlationId = events[0]?.correlationId ?? crypto.randomUUID();
  for (const e of events) {
    await db.query(
      `INSERT INTO audit_events (actor, action, entity_type, entity_id, summary, before, after, correlation_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, now()))`,
      [e.actor, e.action, e.entityType, e.entityId, e.summary,
       e.before === undefined ? null : JSON.stringify(e.before),
       e.after === undefined ? null : JSON.stringify(e.after),
       e.correlationId ?? correlationId, e.occurredAt ?? null],
    );
  }
}

export type AuditRow = {
  id: number; occurred_at: Date; recorded_at: Date | null; actor: string; action: string; summary: string;
  before: unknown; after: unknown; correlation_id: string;
};

export async function auditTrail(entityType: string, entityId: string): Promise<AuditRow[]> {
  const { rows } = await policyDb.query<AuditRow>(
    "SELECT * FROM audit_events WHERE entity_type = $1 AND entity_id = $2 ORDER BY id DESC",
    [entityType, entityId],
  );
  return rows;
}

export type AuditEventRow = AuditRow & { entity_type: string; entity_id: string };

/** Every event of one user action (they share a correlation ID), oldest first. */
export async function auditByCorrelation(correlationId: string): Promise<AuditEventRow[]> {
  const { rows } = await policyDb.query<AuditEventRow>(
    "SELECT * FROM audit_events WHERE correlation_id = $1 ORDER BY id", [correlationId]);
  return rows;
}
