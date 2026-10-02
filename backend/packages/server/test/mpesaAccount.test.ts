/**
 * The tenant's M-Pesa account (accounts.system_key = 'MPESA'): found by
 * system key rather than code, and created on first use. Each test seeds
 * its own tenant so the shared test tenant's chart doesn't interfere.
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withoutTenant, withTenant } from "@jibuks/db";
import * as accountsService from "../src/modules/accounts/service.js";

afterAll(async () => {
  await closePool();
});

async function seedTenant(): Promise<{ tenantId: string; audit: { actorUserId: string } }> {
  const tenantId = randomUUID();
  const userId = randomUUID();
  await withoutTenant(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, name, type, base_currency) VALUES ($1, $2, 'BUSINESS', 'KES')`,
      [tenantId, `M-Pesa Account Tenant ${tenantId}`],
    );
  });
  await withTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, external_idp_subject, name) VALUES ($1, $2, $3, 'M-Pesa Account User')`,
      [userId, tenantId, `test|${userId}`],
    );
  });
  return { tenantId, audit: { actorUserId: userId } };
}

describe("getOrCreateMpesaAccount", () => {
  it("creates M-Pesa at 1020 when the tenant has none, then keeps returning it", async () => {
    const { tenantId, audit } = await seedTenant();

    const first = await accountsService.getOrCreateMpesaAccount(tenantId, audit);
    const second = await accountsService.getOrCreateMpesaAccount(tenantId, audit);

    expect(first).toMatchObject({ code: "1020", name: "M-Pesa", type: "ASSET", system_key: "MPESA" });
    expect(second.id).toBe(first.id);
  });

  it("leaves a business's own 1020 alone and uses the next free code", async () => {
    const { tenantId, audit } = await seedTenant();
    const pettyCash = await accountsService.createAccount(
      { tenantId, code: "1020", name: "Petty Cash", type: "ASSET" },
      audit,
    );
    await accountsService.createAccount({ tenantId, code: "1021", name: "Float", type: "ASSET" }, audit);

    const mpesa = await accountsService.getOrCreateMpesaAccount(tenantId, audit);

    expect(mpesa.id).not.toBe(pettyCash.id);
    expect(mpesa).toMatchObject({ code: "1022", name: "M-Pesa", system_key: "MPESA" });
    const accounts = await accountsService.listAccounts(tenantId);
    expect(accounts.find((a) => a.id === pettyCash.id)).toMatchObject({ name: "Petty Cash", system_key: null });
  });

  it("creates exactly one account when collections race", async () => {
    const { tenantId, audit } = await seedTenant();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => accountsService.getOrCreateMpesaAccount(tenantId, audit)),
    );

    expect(new Set(results.map((a) => a.id)).size).toBe(1);
    const accounts = await accountsService.listAccounts(tenantId);
    expect(accounts.filter((a) => a.system_key === "MPESA")).toHaveLength(1);
  });
});
