-- Requests for a login from the signed-out sign-in page (step 27). Each one is kept here and
-- emailed to the owner; emailed_at / email_error say whether the email went out, so a request
-- is never lost when mail is not set up or the mail server refuses. Listed on Admin → Sign-ins.
CREATE TABLE access_requests (
    id           bigserial PRIMARY KEY,
    created_at   timestamptz NOT NULL DEFAULT now(),
    name         text NOT NULL,
    email        text NOT NULL,
    company      text NOT NULL DEFAULT '',
    ip           text,                       -- client address as the platform reported it (the throttle's key)
    user_agent   text,
    emailed_at   timestamptz,
    email_error  text
);
CREATE INDEX access_requests_time ON access_requests (created_at DESC);
CREATE INDEX access_requests_ip ON access_requests (ip, created_at DESC);
