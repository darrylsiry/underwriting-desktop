-- A renewal is a submission of kind 'renewal': it starts from the expiring policy instead of
-- broker documents, and carries a snapshot of that policy (inputs, schedule, rate version and the
-- expiring rating worksheet) so the renewing terms can be compared with it factor by factor.
ALTER TABLE submissions ADD COLUMN kind text NOT NULL DEFAULT 'new' CHECK (kind IN ('new', 'renewal'));
ALTER TABLE submissions ADD COLUMN renewal_of jsonb;

-- For a renewal: the renewing inputs rated on the *expiring* rate version. With last_rating (the
-- same inputs on the current version) this splits the premium change into "terms changed" and
-- "rates changed". Null when the expiring version can't be rated on.
ALTER TABLE worksheets ADD COLUMN bridge_rating jsonb;
