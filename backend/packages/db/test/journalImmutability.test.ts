/**
 * Automated proof of FR-ACC-02: a journal is editable while DRAFT, but
 * once its status is POSTED, no role may UPDATE or DELETE the row or its
 * lines, for any reason. Correction is only ever by reversal.
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withoutTenant, withTenant } from "../src/index.js";

afterAll(async () => {
  await closePool();
});

interface Fixture {
  tenantId: string;
  userId: string;
  periodId: string;
  cashAccountId: string;
  salesAccountId: string;
}

async function makeFixture(): Promise<Fixture> {
  const tenantId = randomUUID();
  const userId = randomUUID();

  await withoutTenant(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, name, type, base_currency) VALUES ($1, $2, 'BUSINESS', 'KES')`,
      [tenantId, `Tenant ${tenantId}`],
    );
  });

  const { periodId, cashAccountId, salesAccountId } = await withTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, external_idp_subject, name, is_super_admin) VALUES ($1, $2, $3, 'Test User', false)`,
      [userId, tenantId, `test|${userId}`],
    );
    const period = await client.query(
      `INSERT INTO periods (tenant_id, start_date, end_date) VALUES ($1, '2026-07-01', '2026-07-31') RETURNING id`,
      [tenantId],
    );
    const cash = await client.query(
      `INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, '1000', 'Cash', 'ASSET') RETURNING id`,
      [tenantId],
    );
    const sales = await client.query(
      `INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, '4000', 'Sales', 'INCOME') RETURNING id`,
      [tenantId],
    );
    return {
      periodId: period.rows[0].id as string,
      cashAccountId: cash.rows[0].id as string,
      salesAccountId: sales.rows[0].id as string,
    };
  });

  return { tenantId, userId, periodId, cashAccountId, salesAccountId };
}

/** Creates a balanced, posted journal with two lines and returns its id. */
async function makePostedJournal(fixture: Fixture): Promise<string> {
  const journalId = randomUUID();
  await withTenant(fixture.tenantId, async (client) => {
    await client.query(
      `INSERT INTO journals (id, tenant_id, client_uuid, period_id, date, currency, description, source, status, created_by)
       VALUES ($1, $2, $3, $4, '2026-07-15', 'KES', 'Test entry', 'CASHBOOK', 'DRAFT', $5)`,
      [journalId, fixture.tenantId, randomUUID(), fixture.periodId, fixture.userId],
    );
    await client.query(
      `INSERT INTO journal_lines (tenant_id, journal_id, account_id, debit_minor, credit_minor) VALUES ($1, $2, $3, 1000, 0)`,
      [fixture.tenantId, journalId, fixture.cashAccountId],
    );
    await client.query(
      `INSERT INTO journal_lines (tenant_id, journal_id, account_id, debit_minor, credit_minor) VALUES ($1, $2, $3, 0, 1000)`,
      [fixture.tenantId, journalId, fixture.salesAccountId],
    );
    await client.query(`UPDATE journals SET status = 'POSTED' WHERE id = $1`, [journalId]);
  });
  return journalId;
}

describe("journal immutability (FR-ACC-02)", () => {
  it("allows editing a journal's description while it is still a DRAFT", async () => {
    const fixture = await makeFixture();
    const journalId = randomUUID();

    await withTenant(fixture.tenantId, async (client) => {
      await client.query(
        `INSERT INTO journals (id, tenant_id, client_uuid, period_id, date, currency, description, source, status, created_by)
         VALUES ($1, $2, $3, $4, '2026-07-15', 'KES', 'Original', 'CASHBOOK', 'DRAFT', $5)`,
        [journalId, fixture.tenantId, randomUUID(), fixture.periodId, fixture.userId],
      );
      await client.query(`UPDATE journals SET description = 'Edited while draft' WHERE id = $1`, [journalId]);
    });

    const result = await withTenant(fixture.tenantId, async (client) => {
      return client.query(`SELECT description FROM journals WHERE id = $1`, [journalId]);
    });

    expect(result.rows[0]!.description).toBe("Edited while draft");
  });

  it("rejects an UPDATE on a journal once it is POSTED", async () => {
    const fixture = await makeFixture();
    const journalId = await makePostedJournal(fixture);

    await expect(
      withTenant(fixture.tenantId, async (client) => {
        await client.query(`UPDATE journals SET description = 'Changed my mind' WHERE id = $1`, [journalId]);
      }),
    ).rejects.toThrow(/posted and immutable/i);
  });

  it("rejects a DELETE on a journal once it is POSTED", async () => {
    const fixture = await makeFixture();
    const journalId = await makePostedJournal(fixture);

    await expect(
      withTenant(fixture.tenantId, async (client) => {
        await client.query(`DELETE FROM journals WHERE id = $1`, [journalId]);
      }),
    ).rejects.toThrow(/posted and immutable/i);
  });

  it("rejects an UPDATE on a journal LINE once its parent journal is POSTED", async () => {
    const fixture = await makeFixture();
    const journalId = await makePostedJournal(fixture);

    const lineId = await withTenant(fixture.tenantId, async (client) => {
      const result = await client.query(
        `SELECT id FROM journal_lines WHERE journal_id = $1 AND debit_minor > 0`,
        [journalId],
      );
      return result.rows[0]!.id as string;
    });

    await expect(
      withTenant(fixture.tenantId, async (client) => {
        await client.query(`UPDATE journal_lines SET debit_minor = 9999 WHERE id = $1`, [lineId]);
      }),
    ).rejects.toThrow(/immutable/i);
  });

  it("rejects a DELETE on a journal LINE once its parent journal is POSTED", async () => {
    const fixture = await makeFixture();
    const journalId = await makePostedJournal(fixture);

    const lineId = await withTenant(fixture.tenantId, async (client) => {
      const result = await client.query(
        `SELECT id FROM journal_lines WHERE journal_id = $1 AND debit_minor > 0`,
        [journalId],
      );
      return result.rows[0]!.id as string;
    });

    await expect(
      withTenant(fixture.tenantId, async (client) => {
        await client.query(`DELETE FROM journal_lines WHERE id = $1`, [lineId]);
      }),
    ).rejects.toThrow(/immutable/i);
  });
});