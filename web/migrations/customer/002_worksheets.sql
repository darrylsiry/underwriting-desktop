-- The underwriter's working file for an accepted submission: rating inputs
-- (seeded from the reviewed submission, then adjusted), schedule credits and
-- debits with written reasons, cleared referrals, and the latest indicative rating.
CREATE TABLE worksheets (
    submission_id        uuid PRIMARY KEY REFERENCES submissions(id),
    rating_inputs        jsonb NOT NULL,
    schedule             jsonb NOT NULL DEFAULT '[]',   -- [{category, pct, rationale}], pct < 0 is a credit
    referral_clearances  jsonb NOT NULL DEFAULT '{}',   -- rule code -> {by, at, note}
    last_rating          jsonb,                         -- POST /rate response for the current inputs
    rated_inputs_hash    text,                          -- inputs the last rating used, to spot stale ratings
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_by           text NOT NULL,
    updated_at           timestamptz NOT NULL DEFAULT now()
);
