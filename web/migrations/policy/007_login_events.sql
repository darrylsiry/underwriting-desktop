-- Every sign-in attempt on the UW Desktop (the sign-in page) and the first API call of each hour
-- per login, with what the request told us about where it came from. Feeds the sign-in report
-- (/audit/logins, GET /api/reports/logins, scripts/login-report.sh).
CREATE TABLE login_events (
    id              bigserial PRIMARY KEY,
    occurred_at     timestamptz NOT NULL DEFAULT now(),
    username        text NOT NULL,
    success         boolean NOT NULL,
    method          text NOT NULL DEFAULT 'signin',   -- signin (the page) | api (HTTP Basic on /api)
    ip              text,                              -- client address as the platform reported it
    user_agent      text,
    accept_language text,
    edge_region     text,                              -- Fly-Region: the edge that took the request
    geo             jsonb,                             -- country, region, city, timezone, isp (looked up from the IP)
    geo_source      text                               -- which lookup filled geo, or why none did
);
CREATE INDEX login_events_time ON login_events (occurred_at DESC);
CREATE INDEX login_events_user ON login_events (username, occurred_at DESC);
