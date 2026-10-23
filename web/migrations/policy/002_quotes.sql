-- Issued quotes. Each is a priced offer frozen at issue time: the rating
-- inputs, the rating service's response (with its rating_id and rate version),
-- the terms, and the PDF sent to the broker. Re-quoting a submission issues a
-- new version and supersedes the previous one.
CREATE SEQUENCE quote_number_seq;

CREATE TABLE quotes (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_number     text NOT NULL,                -- Q-2026-0001 (same across versions)
    version          int NOT NULL,
    status           text NOT NULL CHECK (status IN ('issued', 'superseded', 'bound')),
    submission_id    uuid NOT NULL,                -- customer DB; no cross-database FK
    submission_ref   text NOT NULL,
    insured_id       uuid,
    insured_name     text NOT NULL,
    effective_date   date NOT NULL,
    expiration_date  date NOT NULL,
    valid_until      date NOT NULL,
    rating_id        uuid NOT NULL,                -- rating service's rating_log row
    rate_version     text NOT NULL,
    rating_inputs    jsonb NOT NULL,
    schedule         jsonb NOT NULL,
    rating           jsonb NOT NULL,               -- full POST /rate response
    premium          numeric(12,2) NOT NULL,
    policy_fee       numeric(12,2) NOT NULL,
    surplus_lines_tax numeric(12,2) NOT NULL,
    total            numeric(12,2) NOT NULL,
    subjectivities   text[] NOT NULL DEFAULT '{}',
    terms            jsonb NOT NULL,               -- limits, deductible, class, exposure, producer for the document
    pdf              bytea NOT NULL,
    issued_by        text NOT NULL,
    issued_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (quote_number, version)
);
CREATE INDEX quotes_submission ON quotes (submission_id, version DESC);
