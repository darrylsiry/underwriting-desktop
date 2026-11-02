import { Pool } from "pg";

// The web app owns two databases: `customer` (insureds, submissions) and
// `policy` (quotes, binders, policies, audit events).
export type DbName = "customer" | "policy";

/** A pool or a checked-out client: anything `query` can run on, so a function can join a caller's transaction. */
export type Queryable = Pick<Pool, "query">;

const urls: Record<DbName, string> = {
  customer: process.env.CUSTOMER_DATABASE_URL ?? "postgresql://uw:uw@localhost:5432/customer",
  policy: process.env.POLICY_DATABASE_URL ?? "postgresql://uw:uw@localhost:5432/policy",
};

// Give up on a database that doesn't answer, so health checks, pages and sign-in can't hang (CR-026).
// query_timeout rather than statement_timeout: node-pg sends statement_timeout as a startup parameter,
// which a PgBouncer in front of the database refuses by default, and that would stop every connection.
const TIMEOUTS = { connectionTimeoutMillis: 5_000, query_timeout: 30_000 };

const globalPools = globalThis as unknown as { __pools?: Record<DbName, Pool> };

export const pools: Record<DbName, Pool> = (globalPools.__pools ??= {
  customer: new Pool({ connectionString: urls.customer, ...TIMEOUTS }),
  policy: new Pool({ connectionString: urls.policy, ...TIMEOUTS }),
});

export const customerDb = pools.customer;
export const policyDb = pools.policy;
