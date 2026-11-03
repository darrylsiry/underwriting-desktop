-- App Tests on the deployment (step 30): the review agents' latest reports, ledger and mockups as
-- the machine that runs them last sent them, so the page is current without a deploy. One row per
-- file; a publish replaces the whole set in one transaction. Never the security report (CR-097).
CREATE TABLE published_reports (
    name         text PRIMARY KEY,               -- as under docs/: CODE_REVIEW.md, ux-mockups/UX-068.html
    body         text NOT NULL,
    written_at   timestamptz NOT NULL,           -- when that file was last written where it was published from
    published_at timestamptz NOT NULL DEFAULT now()
);
