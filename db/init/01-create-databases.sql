-- One Postgres server, three logical databases, each owned by one service.
CREATE DATABASE customer;  -- web: insureds, submissions, documents
CREATE DATABASE policy;    -- web: quotes, binders, policies, audit_events
CREATE DATABASE rating;    -- rating-service: rate tables, versions, rating log
