-- Premium sub-ledger: the journal lines each underwriting action books to the general ledger.
-- Written basis at bind (cash collection and earning are not modelled yet). One journal per
-- action; its lines balance. Each line carries the policy details an auditor needs and the
-- correlation id of the audit events of the action that booked it. Endorsements and cancellations
-- will post the same accounts with reversed amounts.
CREATE SEQUENCE gl_journal_seq;
CREATE SEQUENCE gl_export_seq;

CREATE TABLE gl_postings (
    id                 bigserial PRIMARY KEY,
    journal_no         text NOT NULL,                -- JE-000001, one per booked action
    line_no            int NOT NULL,
    posted_at          timestamptz NOT NULL,         -- when the action booked it
    accounting_period  text NOT NULL,                -- YYYY-MM of posted_at in the books' time zone
    transaction_type   text NOT NULL CHECK (transaction_type IN ('new_business', 'renewal', 'endorsement', 'cancellation')),
    account_code       text NOT NULL,
    account_name       text NOT NULL,
    debit              numeric(12,2) NOT NULL DEFAULT 0,
    credit             numeric(12,2) NOT NULL DEFAULT 0,
    description        text NOT NULL,
    policy_id          uuid NOT NULL REFERENCES policies(id),
    policy_number      text NOT NULL,
    insured_name       text NOT NULL,
    effective_date     date NOT NULL,
    expiration_date    date NOT NULL,
    quote_ref          text NOT NULL,                -- Q-2026-0002 v1
    submission_id      uuid NOT NULL,
    submission_ref     text NOT NULL,
    underwriter        text NOT NULL,
    producer           text NOT NULL DEFAULT '',
    source_action      text NOT NULL,                -- the audit action, e.g. policy.bound
    correlation_id     uuid NOT NULL,                -- that action's audit events
    export_batch       text,                         -- set when pushed to the GL
    exported_at        timestamptz,
    exported_by        text,
    UNIQUE (journal_no, line_no)
);
CREATE INDEX gl_postings_period ON gl_postings (accounting_period, posted_at);
CREATE INDEX gl_postings_policy ON gl_postings (policy_id);

-- Backfill: every policy bound before this table existed gets its journal, at its bind time.
WITH bound AS (
    SELECT p.id, p.policy_number, p.insured_name, p.effective_date, p.expiration_date, p.bound_at, p.bound_by,
           p.premium, p.policy_fee, p.surplus_lines_tax, p.total, p.submission_id, p.renewed_from,
           q.quote_number || ' v' || q.version::text AS quote_ref, q.submission_ref,
           COALESCE(q.terms->'producer'->>0, '') AS producer,
           COALESCE((SELECT a.correlation_id FROM audit_events a
                     WHERE a.entity_type = 'policy' AND a.entity_id = p.id::text AND a.action = 'policy.bound'
                     ORDER BY a.id LIMIT 1), gen_random_uuid()) AS correlation_id,
           'JE-' || lpad(row_number() OVER (ORDER BY p.bound_at, p.policy_number)::text, 6, '0') AS journal_no
    FROM policies p JOIN quotes q ON q.id = p.quote_id
), lines AS (
              SELECT 1 AS line_no, '1200' AS code, 'Premiums receivable' AS name, 'D' AS side, 'total' AS amt
    UNION ALL SELECT 2, '4100', 'Written premium - E&S contractors GL', 'C', 'premium'
    UNION ALL SELECT 3, '4200', 'Policy fee income', 'C', 'policy_fee'
    UNION ALL SELECT 4, '2300', 'Surplus lines tax payable', 'C', 'surplus_lines_tax'
), amounts AS (
    SELECT b.*, l.line_no, l.code, l.name, l.side,
           CASE l.amt WHEN 'total' THEN b.total WHEN 'premium' THEN b.premium WHEN 'policy_fee' THEN b.policy_fee ELSE b.surplus_lines_tax END AS amount
    FROM bound b CROSS JOIN lines l
)
INSERT INTO gl_postings (journal_no, line_no, posted_at, accounting_period, transaction_type, account_code, account_name, debit, credit,
                         description, policy_id, policy_number, insured_name, effective_date, expiration_date, quote_ref,
                         submission_id, submission_ref, underwriter, producer, source_action, correlation_id)
SELECT journal_no, row_number() OVER (PARTITION BY journal_no ORDER BY line_no), bound_at,
       to_char(bound_at AT TIME ZONE 'America/New_York', 'YYYY-MM'),
       CASE WHEN renewed_from IS NULL THEN 'new_business' ELSE 'renewal' END, code, name,
       CASE WHEN side = 'D' THEN amount ELSE 0 END, CASE WHEN side = 'C' THEN amount ELSE 0 END,
       CASE WHEN renewed_from IS NULL THEN 'New business' ELSE 'Renewal' END || ' bound: ' || policy_number || ', ' || insured_name
         || ' (' || to_char(effective_date, 'MM/DD/YYYY') || ' to ' || to_char(expiration_date, 'MM/DD/YYYY') || ')',
       id, policy_number, insured_name, effective_date, expiration_date, quote_ref,
       submission_id, submission_ref, bound_by, producer, 'policy.bound', correlation_id
FROM amounts WHERE amount <> 0
ORDER BY bound_at, journal_no, line_no;

SELECT setval('gl_journal_seq', GREATEST((SELECT count(*) FROM policies), 1), (SELECT count(*) FROM policies) > 0);
