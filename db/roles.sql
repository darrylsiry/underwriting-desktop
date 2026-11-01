-- SEC-007: least-privilege database roles, one per service, for installs that can use them.
--
-- The stack runs as the server's owner role (`uw` locally; the role `fly mpg attach` creates on
-- Fly) because that role must also run migrations at startup. This script adds a runtime role per
-- service with only the table privileges that service needs, and no UPDATE or DELETE on the
-- evidence tables beyond the columns a later step fills in. The append-only triggers in the
-- migrations hold either way; these roles add defence in depth. Safe to re-run.
--
--   Local:  docker compose exec -T db psql -U uw -d postgres -v web_pw="'…'" -v rating_pw="'…'" -f - < db/roles.sql
--   Fly:    fly mpg connect <cluster> then \i this file (or paste it), with the two passwords set.
--   Then point CUSTOMER_DATABASE_URL / POLICY_DATABASE_URL at web_app and DATABASE_URL at rating_app
--   for the request-serving processes, keeping the owner URL for migrations.
--
-- New tables a later migration creates are covered by the ALTER DEFAULT PRIVILEGES lines, as long
-- as the migration runs as the owner role that ran this script.
\set ON_ERROR_STOP on

SELECT format('CREATE ROLE web_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :web_pw)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'web_app') \gexec
SELECT format('CREATE ROLE rating_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :rating_pw)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rating_app') \gexec

ALTER ROLE web_app SET search_path = public;
ALTER ROLE rating_app SET search_path = public;

\connect customer
GRANT CONNECT ON DATABASE customer TO web_app;
GRANT USAGE ON SCHEMA public TO web_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO web_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO web_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO web_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO web_app;
REVOKE ALL ON schema_migrations FROM web_app;
GRANT SELECT ON schema_migrations TO web_app;

\connect policy
GRANT CONNECT ON DATABASE policy TO web_app;
GRANT USAGE ON SCHEMA public TO web_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO web_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO web_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO web_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO web_app;
-- Evidence tables: add rows, read rows, and change only the columns a later step fills in.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events, gl_postings, login_events FROM web_app;
GRANT UPDATE (export_batch, exported_at, exported_by) ON gl_postings TO web_app;
GRANT UPDATE (geo, geo_source) ON login_events TO web_app;
REVOKE ALL ON schema_migrations FROM web_app;
GRANT SELECT ON schema_migrations TO web_app;

\connect rating
GRANT CONNECT ON DATABASE rating TO rating_app;
GRANT USAGE ON SCHEMA public TO rating_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rating_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rating_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rating_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO rating_app;
REVOKE UPDATE, DELETE, TRUNCATE ON rating_log, rate_table_audit FROM rating_app;
REVOKE ALL ON schema_migrations FROM rating_app;
GRANT SELECT ON schema_migrations TO rating_app;
