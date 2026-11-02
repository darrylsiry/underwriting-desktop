-- CR-074: occurred_at is when something happened, and seeding back-dates it. recorded_at is when the
-- row was written, and nobody chooses it: the trigger overwrites whatever an INSERT says, and the
-- append-only trigger refuses any later UPDATE. Rows already here stay NULL, meaning "written before
-- this column existed". Adding a nullable column rewrites no row, so no append-only trigger fires
-- and none has to be lifted.
ALTER TABLE audit_events ADD COLUMN recorded_at timestamptz;
ALTER TABLE audit_events ALTER COLUMN recorded_at SET DEFAULT now();

CREATE OR REPLACE FUNCTION stamp_recorded_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.recorded_at := now();
    RETURN NEW;
END $$;

CREATE TRIGGER audit_events_recorded_at BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION stamp_recorded_at();
