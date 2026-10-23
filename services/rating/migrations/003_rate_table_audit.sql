-- Which version a draft was copied from, so the admin UI can show what changed.
ALTER TABLE rate_versions ADD COLUMN based_on int REFERENCES rate_versions(id);

-- Append-only trail of rate-table changes made through the admin UI/API:
-- drafts created, individual values edited (with before/after and a reason),
-- and versions activated.
CREATE TABLE rate_table_audit (
    id          bigserial PRIMARY KEY,
    version_id  int NOT NULL REFERENCES rate_versions(id),
    actor       text NOT NULL,
    action      text NOT NULL CHECK (action IN ('create_draft', 'update_class', 'update_factor', 'update_parameter', 'activate')),
    entity      text,   -- e.g. 'territory:FL', 'class:98677', 'policy_fee'
    before      jsonb,
    after       jsonb,
    reason      text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_table_audit_version ON rate_table_audit (version_id, id);
