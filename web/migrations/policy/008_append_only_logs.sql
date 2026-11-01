-- SEC-007: the audit trail, the GL sub-ledger and the sign-in log are evidence. Postgres itself now
-- refuses to rewrite them, whatever role the app connects as: rows may be added, never deleted, and
-- the only columns that may change afterwards are the ones a later step legitimately fills in
-- (the GL push batch on a posting, the geo lookup on a sign-in). Enforced with triggers rather than
-- grants so it holds on an existing database and on Fly's managed Postgres, where the app's role
-- owns the tables; db/roles.sql adds the least-privilege roles for installs that can use them.
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE OR REPLACE FUNCTION gl_postings_export_columns_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id, NEW.journal_no, NEW.line_no, NEW.posted_at, NEW.accounting_period, NEW.transaction_type, NEW.account_code,
        NEW.account_name, NEW.debit, NEW.credit, NEW.description, NEW.policy_id, NEW.policy_number, NEW.insured_name,
        NEW.effective_date, NEW.expiration_date, NEW.quote_ref, NEW.submission_id, NEW.submission_ref, NEW.underwriter,
        NEW.producer, NEW.source_action, NEW.correlation_id)
       IS DISTINCT FROM
       (OLD.id, OLD.journal_no, OLD.line_no, OLD.posted_at, OLD.accounting_period, OLD.transaction_type, OLD.account_code,
        OLD.account_name, OLD.debit, OLD.credit, OLD.description, OLD.policy_id, OLD.policy_number, OLD.insured_name,
        OLD.effective_date, OLD.expiration_date, OLD.quote_ref, OLD.submission_id, OLD.submission_ref, OLD.underwriter,
        OLD.producer, OLD.source_action, OLD.correlation_id) THEN
        RAISE EXCEPTION 'gl_postings: only export_batch, exported_at and exported_by may change after posting' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.export_batch IS NOT NULL AND NEW.export_batch IS DISTINCT FROM OLD.export_batch THEN
        RAISE EXCEPTION 'gl_postings: a line pushed to the GL keeps its batch' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION login_events_geo_columns_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id, NEW.occurred_at, NEW.username, NEW.success, NEW.method, NEW.ip, NEW.user_agent, NEW.accept_language, NEW.edge_region)
       IS DISTINCT FROM
       (OLD.id, OLD.occurred_at, OLD.username, OLD.success, OLD.method, OLD.ip, OLD.user_agent, OLD.accept_language, OLD.edge_region) THEN
        RAISE EXCEPTION 'login_events: only geo and geo_source may change after the attempt is recorded' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER gl_postings_no_delete BEFORE DELETE ON gl_postings FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER gl_postings_export_only BEFORE UPDATE ON gl_postings FOR EACH ROW EXECUTE FUNCTION gl_postings_export_columns_only();
CREATE TRIGGER login_events_no_delete BEFORE DELETE ON login_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER login_events_geo_only BEFORE UPDATE ON login_events FOR EACH ROW EXECUTE FUNCTION login_events_geo_columns_only();
