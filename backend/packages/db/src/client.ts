/**
 * Database connection helper.
 *
 * Wraps `pg` so callers never write raw SQL for the tenant-scoping dance
 * (SET app.current_tenant_id) by hand -- getting this wrong anywhere is
 * exactly the kind of application-layer mistake DR-01/C-05 exist to make
 * harmless, but it still has to be done correctly at least once, here.
 */

import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | undefined;

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