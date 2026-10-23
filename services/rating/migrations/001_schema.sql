-- Versioned rate tables. Exactly one version is 'active'; drafts are edited
-- in the admin UI and activated, never edited after activation.
CREATE TABLE rate_versions (
    id            serial PRIMARY KEY,
    label         text NOT NULL UNIQUE,
    status        text NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
    notes         text NOT NULL DEFAULT '',
    created_by    text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    activated_at  timestamptz
);
CREATE UNIQUE INDEX one_active_version ON rate_versions (status) WHERE status = 'active';

-- Base rate per $1,000 of gross receipts, by class code.
CREATE TABLE class_rates (
    version_id   int NOT NULL REFERENCES rate_versions(id),
    class_code   text NOT NULL,
    description  text NOT NULL,
    base_rate    numeric(10,4) NOT NULL,
    min_premium  numeric(12,2) NOT NULL,
    PRIMARY KEY (version_id, class_code)
);

-- Multiplicative factors. `kind` says how `key` is matched:
--   exact: key equals the input (territory, ilf)
--   band:  largest numeric key <= the input (deductible, residential_pct, ...)
CREATE TABLE factors (
    version_id  int NOT NULL REFERENCES rate_versions(id),
    factor      text NOT NULL,
    kind        text NOT NULL CHECK (kind IN ('exact', 'band')),
    key         text NOT NULL,
    value       numeric(8,4) NOT NULL,
    label       text NOT NULL DEFAULT '',
    PRIMARY KEY (version_id, factor, key)
);

-- Scalar settings: schedule/experience mod bounds, fees, surplus lines tax by state.
CREATE TABLE parameters (
    version_id  int NOT NULL REFERENCES rate_versions(id),
    name        text NOT NULL,
    value       numeric(12,4) NOT NULL,
    label       text NOT NULL DEFAULT '',
    PRIMARY KEY (version_id, name)
);

-- Every rating call, for audit and replay.
CREATE TABLE rating_log (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id    int NOT NULL REFERENCES rate_versions(id),
    reference     text,
    requested_by  text NOT NULL,
    request       jsonb NOT NULL,
    result        jsonb NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rating_log_reference ON rating_log (reference);
