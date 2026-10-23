-- Insureds are created when an underwriter accepts a submission's intake.
CREATE TABLE insureds (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    fein        text NOT NULL DEFAULT '',
    state       text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now()
);
-- One insured per FEIN when we have one.
CREATE UNIQUE INDEX insureds_fein ON insureds (fein) WHERE fein <> '';

-- A broker submission: what ingestion extracted, and the underwriter-reviewed version.
CREATE TABLE submissions (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reference        text NOT NULL UNIQUE,                 -- SUB-0001
    status           text NOT NULL DEFAULT 'needs_review' CHECK (status IN ('needs_review', 'accepted')),
    applicant_name   text NOT NULL DEFAULT '',
    data             jsonb NOT NULL,                       -- canonical submission JSON (edited during review)
    extraction       jsonb NOT NULL,                       -- full POST /extract response, never edited
    corrected_fields text[] NOT NULL DEFAULT '{}',          -- paths the underwriter changed
    insured_id       uuid REFERENCES insureds(id),
    received_by      text NOT NULL,
    received_at      timestamptz NOT NULL DEFAULT now(),
    reviewed_by      text,
    reviewed_at      timestamptz
);
CREATE SEQUENCE submission_reference_seq;

CREATE TABLE submission_documents (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id  uuid NOT NULL REFERENCES submissions(id),
    filename       text NOT NULL,
    content_type   text NOT NULL,
    content        bytea NOT NULL,
    uploaded_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX submission_documents_submission ON submission_documents (submission_id);
