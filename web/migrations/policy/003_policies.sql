-- Bound policies. Binding accepts an issued quote as-is: terms and premium come
-- from the quote (no re-rating), the binder and policy documents are generated
-- once and stored as issued.
CREATE SEQUENCE policy_number_seq;

CREATE TABLE policies (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_number     text NOT NULL UNIQUE,             -- GL-26-00001
    binder_number     text NOT NULL UNIQUE,             -- BND-26-00001
    status            text NOT NULL DEFAULT 'bound' CHECK (status IN ('bound')),
    quote_id          uuid NOT NULL UNIQUE REFERENCES quotes(id),
    submission_id     uuid NOT NULL,
    insured_id        uuid,
    insured_name      text NOT NULL,
    effective_date    date NOT NULL,
    expiration_date   date NOT NULL,
    premium           numeric(12,2) NOT NULL,
    policy_fee        numeric(12,2) NOT NULL,
    surplus_lines_tax numeric(12,2) NOT NULL,
    total             numeric(12,2) NOT NULL,
    subjectivities    jsonb NOT NULL,                   -- [{text, status: received|open, due_date}]
    binder_pdf        bytea NOT NULL,
    policy_pdf        bytea NOT NULL,
    bound_by          text NOT NULL,
    bound_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX policies_submission ON policies (submission_id);
