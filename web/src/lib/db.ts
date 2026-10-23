import { Pool } from "pg";

// The web app owns two databases: `customer` (insureds, submissions) and
// `policy` (quotes, binders, policies, audit events).
export type DbName = "customer" | "policy";

const urls: Record<DbName, string> = {
  customer: process.env.CUSTOMER_DATABASE_URL ?? "postgresql://uw:uw@localhost:5432/customer",
  policy: process.env.POLICY_DATABASE_URL ?? "postgresql://uw:uw@localhost:5432/policy",
};

const globalPools = globalThis as unknown as { __pools?: Record<DbName, Pool> };

export const pools: Record<DbName, Pool> = (globalPools.__pools ??= {
  customer: new Pool({ connectionString: urls.customer }),
  policy: new Pool({ connectionString: urls.policy }),
});

export const customerDb = pools.customer;
export const policyDb = pools.policy;
