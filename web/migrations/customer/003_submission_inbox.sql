-- A submission picked up from the broker drop folder records which folder it came from,
-- so the inbox can hide folders already extracted. Unique: two clicks can't pick it up twice.
ALTER TABLE submissions ADD COLUMN inbox_folder text;
CREATE UNIQUE INDEX submissions_inbox_folder ON submissions (inbox_folder) WHERE inbox_folder IS NOT NULL;
