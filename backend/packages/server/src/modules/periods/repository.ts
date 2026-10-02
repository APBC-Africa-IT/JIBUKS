/**
 * Periods repository.
 *
 * The ONLY file permitted to write raw SQL against the `periods` table
 * (AD-02). Backs FR-ACC-03 (period locking) and provides the period data
 * @jibuks/ledger's validateForPosting needs.
 */

import { randomUUID } from "node:crypto";
import { recordAuditLog, withTenant, readAsTenant, type AuditContext } from "@jibuks/db";

export interface PeriodRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly start_date: string;
  readonly end_date: string;
  readonly status: "OPEN" | "CLOSED" | "LOCKED";
  readonly closed_by: string | null;
  readonly closed_at: string | null;
}

export interface CreatePeriodInput {
  readonly tenantId: string;
  readonly startDate: string;
  readonly endDate: string;
}

export async function createPeriod(input: CreatePeriodInput, audit: AuditContext): Promise<PeriodRow> {
  return withTenant(input.tenantId, async (client) => {
    const id = randomUUID();
    const result = await client.query<PeriodRow>(
      `INSERT INTO periods (id, tenant_id, start_date, end_date)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, input.tenantId, input.startDate, input.endDate],
    );
    const period = result.rows[0]!;

    await recordAuditLog(client, {
      tenantId: input.tenantId,
      action: "CREATE",
      entityType: "period",
      entityId: period.id,
      afterState: period,
      context: audit,
    });

    return period;
  });
}

export async function listPeriods(tenantId: string): Promise<PeriodRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<PeriodRow>(`SELECT * FROM periods ORDER BY start_date ASC`);
    return result.rows;
  });
}

export async function getPeriodById(tenantId: string, periodId: string): Promise<PeriodRow | null> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<PeriodRow>(`SELECT * FROM periods WHERE id = $1`, [periodId]);
    return result.rows[0] ?? null;
  });
}

/**
 * Find the period covering a given date, for a tenant. This is the same
 * lookup @jibuks/ledger's PostingContext needs -- exposed here so the
 * journals module's service layer can build that context without touching
 * this table's SQL directly (AD-02).
 */
export async function findPeriodForDate(tenantId: string, date: string): Promise<PeriodRow | null> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<PeriodRow>(
      `SELECT * FROM periods WHERE start_date <= $1 AND end_date >= $1 LIMIT 1`,
      [date],
    );
    return result.rows[0] ?? null;
  });
}

/**
 * Opens a period for `date`, spanning [monthStart, monthEnd] narrowed so it
 * never overlaps an existing period, unless one already covers `date`.
 * A per-tenant advisory lock serialises this, so two postings racing on
 * the 1st of the month can't both create one. Returns the period covering
 * `date` either way.
 */
export async function createPeriodCoveringDate(
  tenantId: string,
  date: string,
  monthStart: string,
  monthEnd: string,
  audit: AuditContext,
): Promise<PeriodRow> {
  return withTenant(tenantId, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('periods:' || $1))`, [tenantId]);

    const covering = await client.query<PeriodRow>(
      `SELECT * FROM periods WHERE start_date <= $1 AND end_date >= $1 LIMIT 1`,
      [date],
    );
    if (covering.rows[0]) {
      return covering.rows[0];
    }

    // Shrink the month around `date` to the gap left by neighbouring periods.
    const bounds = await client.query<{ start_date: string; end_date: string }>(
      `SELECT
         GREATEST($2::date, (SELECT MAX(end_date) + 1 FROM periods WHERE end_date < $1 AND end_date >= $2)) AS start_date,
         LEAST($3::date, (SELECT MIN(start_date) - 1 FROM periods WHERE start_date > $1 AND start_date <= $3)) AS end_date`,
      [date, monthStart, monthEnd],
    );
    const { start_date, end_date } = bounds.rows[0]!;

    const result = await client.query<PeriodRow>(
      `INSERT INTO periods (id, tenant_id, start_date, end_date)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [randomUUID(), tenantId, start_date, end_date],
    );
    const period = result.rows[0]!;

    await recordAuditLog(client, {
      tenantId,
      action: "CREATE",
      entityType: "period",
      entityId: period.id,
      afterState: period,
      context: audit,
    });

    return period;
  });
}

export async function setPeriodStatus(
  tenantId: string,
  periodId: string,
  status: "OPEN" | "CLOSED" | "LOCKED",
  audit: AuditContext,
): Promise<PeriodRow | null> {
  return withTenant(tenantId, async (client) => {
    const before = await client.query<PeriodRow>(`SELECT * FROM periods WHERE id = $1`, [periodId]);
    if (before.rows.length === 0) {
      return null;
    }

    const closedFields =
      status === "OPEN"
        ? { closed_by: null, closed_at: null }
        : { closed_by: audit.actorUserId, closed_at: new Date().toISOString() };

    const result = await client.query<PeriodRow>(
      `UPDATE periods SET status = $2, closed_by = $3, closed_at = $4 WHERE id = $1 RETURNING *`,
      [periodId, status, closedFields.closed_by, closedFields.closed_at],
    );
    const period = result.rows[0]!;

    await recordAuditLog(client, {
      tenantId,
      action: "UPDATE",
      entityType: "period",
      entityId: period.id,
      beforeState: before.rows[0],
      afterState: period,
      context: audit,
    });

    return period;
  });
}