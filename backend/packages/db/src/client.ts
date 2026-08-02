/**
 * Database connection helper.
 *
 * Wraps `pg` so callers never write raw SQL for the tenant-scoping dance
 * (SET app.current_tenant_id) by hand -- getting this wrong anywhere is
 * exactly the kind of application-layer mistake DR-01/C-05 exist to make
 * harmless, but it still has to be done correctly at least once, here.
 */

import pg from "pg";

// Postgres' `date` type (OID 1082) is parsed by pg into a JS Date object by
// default, which always carries a timestamp -- serializing it back to JSON
// reintroduces a time component shifted by the server process's local
// timezone. Section 9.1 requires accounting dates be transmitted as pure
// calendar dates with no time component, so we disable that parsing and
// keep dates as the plain "YYYY-MM-DD" string Postgres already returns.
pg.types.setTypeParser(1082, (value: string) => value);

const { Pool } = pg;

let pool: pg.Pool | undefined;
let authResolverPool: pg.Pool | undefined;

/**
 * A SEPARATE connection pool, using a distinct, narrowly-scoped database
 * role (jibuks_auth_resolver) that bypasses RLS -- reserved exclusively for
 * resolving a verified identity to its tenant, where the tenant is exactly
 * what's being discovered. Never use this pool for anything else; every
 * other query in the system must go through the ordinary tenant-scoped
 * pool via withTenant/readAsTenant, which stays fully RLS-protected.
 */
export function getAuthResolverPool(): pg.Pool {
  if (!authResolverPool) {
    const connectionString = process.env["AUTH_RESOLVER_DATABASE_URL"];
    if (!connectionString) {
      throw new Error("AUTH_RESOLVER_DATABASE_URL is not set");
    }
    authResolverPool = new Pool({ connectionString });
  }
  return authResolverPool;
}

/**
 * Runs a read-only query against the auth-resolver pool. There is no
 * tenant-scoping here by design -- this is the one deliberate, narrow,
 * auditable exception to RLS in the whole system.
 */
export async function withAuthResolver<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getAuthResolverPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env["DATABASE_URL"];
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
  if (authResolverPool) {
    await authResolverPool.end();
    authResolverPool = undefined;
  }
}

/**
 * Run a function with a client whose session has app.current_tenant_id set
 * for the duration of the callback. Uses SET LOCAL inside a transaction so
 * the setting cannot leak onto a pooled connection reused by an unrelated
 * later query -- a real risk with connection pooling and session-level SET.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // SET LOCAL cannot take a parameterised value, so the tenant id is
    // interpolated directly. This is safe ONLY because tenantId is always
    // a UUID we generated or validated ourselves, never raw user input
    // passed straight through -- callers must not relax that.
    await client.query(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Run a function with a client that has NO tenant context set at all --
 * useful for proving RLS hides everything when no tenant is identified. */
export async function withoutTenant<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Run a read-only query scoped to a tenant, without the overhead of a full
 * BEGIN/COMMIT transaction. Still uses SET LOCAL semantics via a short
 * transaction internally -- Postgres has no non-transactional way to scope
 * a session-local GUC safely on a pooled connection, so this is the same
 * SET LOCAL approach as withTenant, just named to signal read-only intent
 * at call sites.
 */
export async function readAsTenant<T>(
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withTenant(tenantId, fn);
}