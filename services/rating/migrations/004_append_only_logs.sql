-- SEC-007: the rating log and the rate-table audit trail are evidence of what was rated on which
-- rates and who changed them. Postgres refuses to rewrite them whatever role connects: append only.
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER rating_log_append_only BEFORE UPDATE OR DELETE ON rating_log FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER rate_table_audit_append_only BEFORE UPDATE OR DELETE ON rate_table_audit FOR EACH ROW EXECUTE FUNCTION forbid_change();
