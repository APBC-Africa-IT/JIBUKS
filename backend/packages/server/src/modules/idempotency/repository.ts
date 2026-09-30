/**
 * Idempotency keys repository.
 *
 * The ONLY file permitted to write raw SQL against `idempotency_keys`
 * (AD-02). Each call runs in its own short tenant-scoped transaction,
 * deliberately separate from the handler's own transaction -- the claim
 * must be committed (and visible to a concurrent retry) BEFORE the handler
 * starts, not rolled back with it.
 */

import { withTenant } from "@jibuks/db";

export interface IdempotencyKeyRow {
  readonly tenant_id: string;
  readonly key: string;
  readonly request_hash: string;
  readonly status: "IN_PROGRESS" | "COMPLETED";
  readonly response_status: number | null;
  readonly response_body: unknown;
  readonly created_at: string;
  readonly completed_at: string | null;
}

/**
 * How long an IN_PROGRESS claim is honoured before a retry may take it
 * over. Covers a process that crashed mid-request and never completed or
 * released its claim. Re-executing after a takeover is still safe: every
 * ledger write is also guarded by its clientUuid unique constraint.
 */
const STALE_CLAIM_SECONDS = 60;

export type ClaimResult =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly existing: IdempotencyKeyRow };

/**
 * Atomically claims `key` for this request. Either inserts a fresh
 * IN_PROGRESS row, takes over a stale IN_PROGRESS row for the same
 * request, or returns the existing row for the caller to act on.
 */
export async function claim(tenantId: string, key: string, requestHash: string): Promise<ClaimResult> {
  return withTenant(tenantId, async (client) => {
    const inserted = await client.query(
      `INSERT INTO idempotency_keys (tenant_id, key, request_hash, status)
       VALUES ($1, $2, $3, 'IN_PROGRESS')
       ON CONFLICT (tenant_id, key) DO NOTHING
       RETURNING key`,
      [tenantId, key, requestHash],
    );
    if (inserted.rowCount === 1) {
      return { claimed: true } as const;
    }

    const takenOver = await client.query(
      `UPDATE idempotency_keys
          SET created_at = now()
        WHERE tenant_id = $1 AND key = $2 AND request_hash = $3
          AND status = 'IN_PROGRESS'
          AND created_at < now() - make_interval(secs => $4)
       RETURNING key`,
      [tenantId, key, requestHash, STALE_CLAIM_SECONDS],
    );
    if (takenOver.rowCount === 1) {
      return { claimed: true } as const;
    }

    const existing = await client.query<IdempotencyKeyRow>(
      `SELECT * FROM idempotency_keys WHERE tenant_id = $1 AND key = $2`,
      [tenantId, key],
    );
    const row = existing.rows[0];
    if (!row) {
      // Released between our INSERT and SELECT -- vanishingly rare. Report
      // it as in progress; the client's retry will claim it cleanly.
      return {
        claimed: false,
        existing: {
          tenant_id: tenantId,
          key,
          request_hash: requestHash,
          status: "IN_PROGRESS",
          response_status: null,
          response_body: null,
          created_at: new Date().toISOString(),
          completed_at: null,
        },
      } as const;
    }
    return { claimed: false, existing: row } as const;
  });
}

/** Stores the original 2xx response so later repeats can replay it. */
export async function complete(
  tenantId: string,
  key: string,
  responseStatus: number,
  responseBody: unknown,
): Promise<void> {
  await withTenant(tenantId, async (client) => {
    await client.query(
      `UPDATE idempotency_keys
          SET status = 'COMPLETED', response_status = $3, response_body = $4, completed_at = now()
        WHERE tenant_id = $1 AND key = $2`,
      [tenantId, key, responseStatus, JSON.stringify(responseBody ?? null)],
    );
  });
}

/** Drops an IN_PROGRESS claim whose request failed, freeing the key for a retry. */
export async function release(tenantId: string, key: string): Promise<void> {
  await withTenant(tenantId, async (client) => {
    await client.query(
      `DELETE FROM idempotency_keys WHERE tenant_id = $1 AND key = $2 AND status = 'IN_PROGRESS'`,
      [tenantId, key],
    );
  });
}
