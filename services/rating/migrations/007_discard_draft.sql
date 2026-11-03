-- A draft nobody will use can be discarded (UX-066). The row and its audit stay; it just leaves the lists.
ALTER TABLE rate_versions DROP CONSTRAINT rate_versions_status_check;
ALTER TABLE rate_versions ADD CONSTRAINT rate_versions_status_check CHECK (status IN ('draft', 'active', 'retired', 'discarded'));
ALTER TABLE rate_table_audit DROP CONSTRAINT rate_table_audit_action_check;
ALTER TABLE rate_table_audit ADD CONSTRAINT rate_table_audit_action_check CHECK (action IN ('create_draft', 'update_class', 'update_factor', 'update_parameter', 'activate', 'discard'));
