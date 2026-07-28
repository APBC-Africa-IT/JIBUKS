/**
 * Automated proof of DR-04: the sum of debit_minor MUST equal the sum of
 * credit_minor for every journal, enforced by the database via a deferred
 * constraint trigger -- not application logic alone.
 *
 * Mirrors the manual proof: a journal with lines inserted one at a time
 * balances or fails only at COMMIT, never mid-transaction.
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withoutTenant, withTenant } from "../src/index.js";
import type { PoolClient } from "pg";

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

/** Sets up a tenant with a user, an open period, and two accounts to post against. */
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

async function insertJournal(client: PoolClient, fixture: Fixture, journalId: string): Promise<void> {
  await client.query(
    `INSERT INTO journals (id, tenant_id, client_uuid, period_id, date, currency, description, source, status, created_by)
     VALUES ($1, $2, $3, $4, '2026-07-15', 'KES', 'Test entry', 'CASHBOOK', 'DRAFT', $5)`,
    [journalId, fixture.tenantId, randomUUID(), fixture.periodId, fixture.userId],
  );
}

describe("journal balance trigger (DR-04)", () => {
  it("allows lines to be inserted one at a time as long as the transaction balances by COMMIT", async () => {
    const fixture = await makeFixture();
    const journalId = randomUUID();

    await withTenant(fixture.tenantId, async (client) => {
      await insertJournal(client, fixture, journalId);

      // First line alone does NOT balance -- must not throw here.
      await client.query(
        `INSERT INTO journal_lines (tenant_id, journal_id, account_id, debit_minor, credit_minor) VALUES ($1, $2, $3, 1000, 0)`,
        [fixture.tenantId, journalId, fixture.cashAccountId],
      );

      // Second line completes the balance.
      await client.query(
        `INSERT INTO journal_lines (tenant_id, journal_id, account_id, debit_minor, credit_minor) VALUES ($1, $2, $3, 0, 1000)`,
        [fixture.tenantId, journalId, fixture.salesAccountId],
      );
    });

    const lines = await withTenant(fixture.tenantId, async (client) => {
      const result = await client.query(`SELECT debit_minor, credit_minor FROM journal_lines WHERE journal_id = $1`, [
        journalId,
      ]);
      return result.rows;
    });

    expect(lines).toHaveLength(2);
  });

  it("rejects the whole transaction if debits and credits do not match at COMMIT", async () => {
    const fixture = await makeFixture();
    const journalId = randomUUID();

    await expect(
      withTenant(fixture.tenantId, async (client) => {
        await insertJournal(client, fixture, journalId);

        await client.query(
          `INSERT INTO journal_lines (tenant_id, journal_id, account_id, debit_minor, credit_minor) VALUES ($1, $2, $3, 1500, 0)`,
          [fixture.tenantId, journalId, fixture.cashAccountId],
        );

        await client.query(
          `INSERT INTO journal_lines (tenant_id, journal_id, account_id, debit_minor, credit_minor) VALUES ($1, $2, $3, 0, 1000)`,
          [fixture.tenantId, journalId, fixture.salesAccountId],
        );
      }),
    ).rejects.toThrow(/does not balance/i);

    // Nothing from the failed transaction should have persisted.
    const lines = await withTenant(fixture.tenantId, async (client) => {
      const result = await client.query(`SELECT id FROM journal_lines WHERE journal_id = $1`, [journalId]);
      return result.rows;
    });
    expect(lines).toHaveLength(0);

    const journals = await withTenant(fixture.tenantId, async (client) => {
      const result = await client.query(`SELECT id FROM journals WHERE id = $1`, [journalId]);
      return result.rows;
    });
    expect(journals).toHaveLength(0);
  });
});