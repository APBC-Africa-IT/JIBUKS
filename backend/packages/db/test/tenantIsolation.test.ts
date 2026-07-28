/**
 * Automated proof of tenant isolation (DR-01, C-05), covering the exact
 * scenario we first verified by hand: two tenants, each with their own
 * period/account, and a session scoped to one tenant must never see the
 * other's rows -- even with no WHERE clause at all.
 *
 * Each test creates its own fresh tenants with random UUIDs so runs never
 * collide with each other or with earlier manual testing. Nothing is
 * deleted afterward -- consistent with this system's append-only design.
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withTenant, withoutTenant } from "../src/index.js";

async function makeTenant(name: string): Promise<string> {
  const id = randomUUID();
  await withoutTenant(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, name, type, base_currency) VALUES ($1, $2, 'BUSINESS', 'KES')`,
      [id, name],
    );
  });
  return id;
}

afterAll(async () => {
  await closePool();
});

describe("tenant isolation on periods", () => {
  it("a session scoped to tenant A cannot see tenant B's period", async () => {
    const tenantA = await makeTenant(`Tenant A ${randomUUID()}`);
    const tenantB = await makeTenant(`Tenant B ${randomUUID()}`);

    await withTenant(tenantA, async (client) => {
      await client.query(
        `INSERT INTO periods (tenant_id, start_date, end_date) VALUES ($1, '2026-07-01', '2026-07-31')`,
        [tenantA],
      );
    });

    await withTenant(tenantB, async (client) => {
      await client.query(
        `INSERT INTO periods (tenant_id, start_date, end_date) VALUES ($1, '2026-07-01', '2026-07-31')`,
        [tenantB],
      );
    });

    const rowsVisibleToB = await withTenant(tenantB, async (client) => {
      const result = await client.query(`SELECT tenant_id FROM periods`);
      return result.rows;
    });

    expect(rowsVisibleToB).toHaveLength(1);
    expect(rowsVisibleToB[0]!.tenant_id).toBe(tenantB);
  });

  it("a session with no tenant context sees no periods at all", async () => {
    const tenantA = await makeTenant(`Tenant ${randomUUID()}`);

    await withTenant(tenantA, async (client) => {
      await client.query(
        `INSERT INTO periods (tenant_id, start_date, end_date) VALUES ($1, '2026-07-01', '2026-07-31')`,
        [tenantA],
      );
    });

    const rowsVisibleWithNoTenant = await withoutTenant(async (client) => {
      const result = await client.query(`SELECT tenant_id FROM periods WHERE tenant_id = $1`, [tenantA]);
      return result.rows;
    });

    // Fails safe: no tenant context set means the RLS policy matches
    // nothing, even when the caller explicitly filters by the real id.
    expect(rowsVisibleWithNoTenant).toHaveLength(0);
  });
});

describe("tenant isolation on accounts", () => {
  it("a session scoped to tenant A cannot see tenant B's chart of accounts", async () => {
    const tenantA = await makeTenant(`Tenant A ${randomUUID()}`);
    const tenantB = await makeTenant(`Tenant B ${randomUUID()}`);

    await withTenant(tenantA, async (client) => {
      await client.query(
        `INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, '1000', 'Cash', 'ASSET')`,
        [tenantA],
      );
    });

    await withTenant(tenantB, async (client) => {
      await client.query(
        `INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, '1000', 'Cash', 'ASSET')`,
        [tenantB],
      );
    });

    const rowsVisibleToA = await withTenant(tenantA, async (client) => {
      const result = await client.query(`SELECT tenant_id, code FROM accounts`);
      return result.rows;
    });

    expect(rowsVisibleToA).toHaveLength(1);
    expect(rowsVisibleToA[0]!.tenant_id).toBe(tenantA);
  });

  it("two different tenants can each use the same account code without conflict", async () => {
    const tenantA = await makeTenant(`Tenant A ${randomUUID()}`);
    const tenantB = await makeTenant(`Tenant B ${randomUUID()}`);

    // Both succeed -- accounts_tenant_code_unique is scoped per tenant,
    // not global.
    await withTenant(tenantA, async (client) => {
      await client.query(
        `INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, '4000', 'Sales', 'INCOME')`,
        [tenantA],
      );
    });

    await expect(
      withTenant(tenantB, async (client) => {
        await client.query(
          `INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, '4000', 'Sales', 'INCOME')`,
          [tenantB],
        );
      }),
    ).resolves.not.toThrow();
  });

  it("rejects a duplicate account code within the SAME tenant", async () => {
    const tenantA = await makeTenant(`Tenant ${randomUUID()}`);

    await withTenant(tenantA, async (client) => {
      await client.query(
        `INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, '5000', 'Rent', 'EXPENSE')`,
        [tenantA],
      );
    });

    await expect(
      withTenant(tenantA, async (client) => {
        await client.query(
          `INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, '5000', 'Rent Duplicate', 'EXPENSE')`,
          [tenantA],
        );
      }),
    ).rejects.toThrow(/duplicate key|unique constraint/i);
  });
});