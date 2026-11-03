-- A submission can end without a bind (UX-068). `decline` holds who, when, why and the status to go
-- back to if it is reopened; null while the file is live.
ALTER TABLE submissions DROP CONSTRAINT submissions_status_check;
ALTER TABLE submissions ADD CONSTRAINT submissions_status_check CHECK (status IN ('needs_review', 'accepted', 'declined'));
ALTER TABLE submissions ADD COLUMN decline jsonb;
