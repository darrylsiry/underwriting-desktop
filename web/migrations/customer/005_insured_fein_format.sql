-- CR-040: one stored format for FEINs, so accepting 74-3810922 and 743810922 finds one customer.
-- New accepts store NN-NNNNNNN; this brings existing insureds into line. A FEIN that isn't nine
-- digits is left as typed. If two insureds already share a FEIN in different punctuation, one takes
-- the formatted value (the one that has it already, else the oldest) and the other keeps what it
-- has: merging customers means moving submissions and policies between databases, which a
-- migration shouldn't decide.
WITH ranked AS (
  SELECT id, formatted,
         row_number() OVER (PARTITION BY formatted ORDER BY (fein = formatted) DESC, created_at, id) AS rn
  FROM (
    SELECT id, fein, created_at, regexp_replace(fein, '[^0-9]', '', 'g') AS digits,
           substr(regexp_replace(fein, '[^0-9]', '', 'g'), 1, 2) || '-' || substr(regexp_replace(fein, '[^0-9]', '', 'g'), 3) AS formatted
    FROM insureds
    WHERE fein <> ''
  ) candidates
  WHERE length(digits) = 9
)
UPDATE insureds i
SET fein = r.formatted
FROM ranked r
WHERE i.id = r.id AND r.rn = 1 AND i.fein <> r.formatted;
