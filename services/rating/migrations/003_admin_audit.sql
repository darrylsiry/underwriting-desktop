-- Rate-table admin: drafts remember the version they were cloned from, and
-- every admin change (create draft, edit a table, activate) is audited.
ALTER TABLE rate_versions ADD COLUMN based_on int REFERENCES rate_versions(id);

CREATE TABLE rate_table_audit (
    id          bigserial PRIMARY KEY,
    version_id  int NOT NULL REFERENCES rate_versions(id),
    action      text NOT NULL,          -- create_draft | update_table | activate
    target      text NOT NULL,          -- e.g. 'factor:territory', 'classes', 'version'
    actor       text NOT NULL,
    summary     text NOT NULL,          -- human-readable, e.g. 'NY: 1.6 → 1.75'
    before      jsonb,
    after       jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_table_audit_version ON rate_table_audit (version_id, id);
