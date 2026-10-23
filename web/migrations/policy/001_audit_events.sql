-- Append-only audit trail for every change the UW Desktop makes (who, what, entity, before/after).
CREATE TABLE audit_events (
    id              bigserial PRIMARY KEY,
    occurred_at     timestamptz NOT NULL DEFAULT now(),
    actor           text NOT NULL,
    action          text NOT NULL,          -- e.g. submission.received, submission.field_corrected
    entity_type     text NOT NULL,          -- submission | insured | quote | policy
    entity_id       text NOT NULL,
    summary         text NOT NULL DEFAULT '',
    before          jsonb,
    after           jsonb,
    correlation_id  uuid NOT NULL DEFAULT gen_random_uuid()
);
CREATE INDEX audit_events_entity ON audit_events (entity_type, entity_id, id);
