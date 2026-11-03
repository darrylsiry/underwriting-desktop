-- A quote can be closed as not taken, and a policy marked non-renewed, each with a reason (UX-068).
ALTER TABLE quotes DROP CONSTRAINT quotes_status_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_status_check CHECK (status IN ('issued', 'superseded', 'bound', 'not_taken'));
ALTER TABLE quotes ADD COLUMN closed jsonb;            -- {reason, note, by, at}
ALTER TABLE policies ADD COLUMN non_renewal jsonb;     -- {reason, note, by, at}
ALTER TABLE book_policies ADD COLUMN non_renewal jsonb;
