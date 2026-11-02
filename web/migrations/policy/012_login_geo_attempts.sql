-- CR-091: a failed location lookup is retried a few times, not before every report for ever. This
-- counter is bookkeeping beside the evidence: login_events_geo_only compares the recorded columns
-- by name, so it may change while they can't.
ALTER TABLE login_events ADD COLUMN geo_attempts integer NOT NULL DEFAULT 0;
