/**
 * HTTP-level tests for the suppliers module. Mirrors customers.test.ts --
 * suppliers/repository.ts is customers/repository.ts with the balance sign
 * flipped to the credit side (AP-like: money we owe them).
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withoutTenant, withTenant } from "@jibuks/db";
import { createApp } from "../src/app.js";
import { authHeader, TEST_TENANT_ID } from "./testAuth.js";

const app = createApp();

afterAll(async () => {
  await closePool();
});

function uniqueName(prefix: string): string {
  return `${prefix} ${randomUUID().slice(0, 8)}`;
}

describe("POST /api/v1/suppliers", () => {
  it("creates a supplier and returns 201 with the full row", async () => {
    const name = uniqueName("Acme Supplies");

    const response = await request(app)
      .post("/api/v1/suppliers")
      .set("Authorization", await authHeader())
      .send({ name, phone: "+254711111111" });

    expect(response.status).toBe(201);
    expect(response.body.name).toBe(name);
    expect(response.body.phone).toBe("+254711111111");
    expect(response.body.tenant_id).toBe(TEST_TENANT_ID);
    expect(response.body.is_active).toBe(true);
  });

  it("rejects a request with no Authorization header", async () => {
    const response = await request(app).post("/api/v1/suppliers").send({ name: uniqueName("No Auth") });

    expect(response.status).toBe(401);
  });

  it("rejects an empty name with a precise 400 validation error", async () => {
    const response = await request(app)
      .post("/api/v1/suppliers")
      .set("Authorization", await authHeader())
      .send({ name: "" });

    expect(response.status).toBe(400);
    expect(response.body.title).toBe("VALIDATION_ERROR");
    expect(response.body.errors[0].path).toBe("name");
  });

  it("records an audit log entry for the created supplier", async () => {
    const response = await request(app)
      .post("/api/v1/suppliers")
      .set("Authorization", await authHeader())
      .send({ name: uniqueName("Audit Supplier") });

    const supplierId = response.body.id as string;

    const auditRows = await withTenant(TEST_TENANT_ID, async (client) => {
      const result = await client.query(`SELECT action, entity_id FROM audit_logs WHERE entity_id = $1`, [
        supplierId,
      ]);
      return result.rows;
    });

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.action).toBe("CREATE");
  });
});

describe("GET /api/v1/suppliers", () => {
  it("lists suppliers for the authenticated tenant, excluding a second, separately-seeded tenant", async () => {
    const name = uniqueName("Own Tenant Supplier");

    await request(app)
      .post("/api/v1/suppliers")
      .set("Authorization", await authHeader())
      .send({ name });

    const otherTenantId = randomUUID();
    await withoutTenant(async (client) => {
      await client.query(
        `INSERT INTO tenants (id, name, type, base_currency) VALUES ($1, $2, 'BUSINESS', 'KES')`,
        [otherTenantId, `Other Tenant ${otherTenantId}`],
      );
    });
    await withTenant(otherTenantId, async (client) => {
      await client.query(`INSERT INTO suppliers (tenant_id, name) VALUES ($1, 'Other Tenant Supplier')`, [
        otherTenantId,
      ]);
    });

    const response = await request(app).get("/api/v1/suppliers").set("Authorization", await authHeader());

    expect(response.status).toBe(200);
    expect(response.body.data.some((s: { name: string }) => s.name === name)).toBe(true);
    expect(response.body.data.every((s: { tenant_id: string }) => s.tenant_id === TEST_TENANT_ID)).toBe(true);
  });
});

describe("GET /api/v1/suppliers/:id", () => {
  it("returns 404 for a supplier that does not exist", async () => {
    const response = await request(app)
      .get(`/api/v1/suppliers/${randomUUID()}`)
      .set("Authorization", await authHeader());

    expect(response.status).toBe(404);
    expect(response.body.title).toBe("SUPPLIER_NOT_FOUND");
  });
});

describe("POST /api/v1/suppliers/:id/deactivate", () => {
  it("deactivates a supplier, never deleting it", async () => {
    const created = await request(app)
      .post("/api/v1/suppliers")
      .set("Authorization", await authHeader())
      .send({ name: uniqueName("Deactivate Me") });

    const supplierId = created.body.id as string;

    const response = await request(app)
      .post(`/api/v1/suppliers/${supplierId}/deactivate`)
      .set("Authorization", await authHeader());

    expect(response.status).toBe(200);
    expect(response.body.is_active).toBe(false);

    const stillExists = await request(app)
      .get(`/api/v1/suppliers/${supplierId}`)
      .set("Authorization", await authHeader());
    expect(stillExists.status).toBe(200);
    expect(stillExists.body.is_active).toBe(false);
  });
});

describe("POST /api/v1/suppliers/:id/reactivate", () => {
  it("reactivates a previously deactivated supplier", async () => {
    const created = await request(app)
      .post("/api/v1/suppliers")
      .set("Authorization", await authHeader())
      .send({ name: uniqueName("Reactivate Me") });

    const supplierId = created.body.id as string;

    await request(app).post(`/api/v1/suppliers/${supplierId}/deactivate`).set("Authorization", await authHeader());

    const reactivated = await request(app)
      .post(`/api/v1/suppliers/${supplierId}/reactivate`)
      .set("Authorization", await authHeader());

    expect(reactivated.status).toBe(200);
    expect(reactivated.body.is_active).toBe(true);
  });

  it("returns 404 when reactivating a supplier that does not exist", async () => {
    const response = await request(app)
      .post(`/api/v1/suppliers/${randomUUID()}/reactivate`)
      .set("Authorization", await authHeader());

    expect(response.status).toBe(404);
    expect(response.body.title).toBe("SUPPLIER_NOT_FOUND");
  });
});

describe("GET /api/v1/suppliers (balance_minor)", () => {
  interface BalanceFixture {
    supplierId: string;
    apAccountId: string;
    expenseAccountId: string;
  }

  /** Seeds a period, an AP-like LIABILITY account, an EXPENSE account, and a
   * supplier under TEST_TENANT_ID. Journals are posted over HTTP, tagging
   * the AP line with supplierId -- exactly how a real "Write Bill" would
   * work once that guided endpoint exists. */
  async function makeBalanceFixture(): Promise<BalanceFixture> {
    await withTenant(TEST_TENANT_ID, async (client) => {
      await client.query(
        `INSERT INTO periods (tenant_id, start_date, end_date) VALUES ($1, '2026-08-01', '2026-08-31')`,
        [TEST_TENANT_ID],
      );
    });

    const ap = await request(app)
      .post("/api/v1/accounts")
      .set("Authorization", await authHeader())
      .send({ code: randomUUID().slice(0, 8), name: "Accounts Payable Test", type: "LIABILITY" });
    const expense = await request(app)
      .post("/api/v1/accounts")
      .set("Authorization", await authHeader())
      .send({ code: randomUUID().slice(0, 8), name: "Purchases Test", type: "EXPENSE" });
    const supplier = await request(app)
      .post("/api/v1/suppliers")
      .set("Authorization", await authHeader())
      .send({ name: uniqueName("Balance Supplier") });

    return {
      supplierId: supplier.body.id as string,
      apAccountId: ap.body.id as string,
      expenseAccountId: expense.body.id as string,
    };
  }

  it("computes balance_minor from journal lines tagged with supplierId, on the credit side", async () => {
    const fixture = await makeBalanceFixture();

    await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        date: "2026-08-15",
        currency: "KES",
        description: "Bill received",
        source: "MANUAL",
        lines: [
          { accountId: fixture.expenseAccountId, debitMinor: 80000, creditMinor: 0 },
          { accountId: fixture.apAccountId, debitMinor: 0, creditMinor: 80000, supplierId: fixture.supplierId },
        ],
      });

    const response = await request(app)
      .get(`/api/v1/suppliers/${fixture.supplierId}`)
      .set("Authorization", await authHeader());

    expect(response.status).toBe(200);
    expect(response.body.balance_minor).toBe("80000");
  });

  it("nets a bill payment (debit) against a prior bill (credit) for the same supplier", async () => {
    const fixture = await makeBalanceFixture();

    await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        date: "2026-08-05",
        currency: "KES",
        description: "Bill received",
        source: "MANUAL",
        lines: [
          { accountId: fixture.expenseAccountId, debitMinor: 50000, creditMinor: 0 },
          { accountId: fixture.apAccountId, debitMinor: 0, creditMinor: 50000, supplierId: fixture.supplierId },
        ],
      });
    await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        date: "2026-08-20",
        currency: "KES",
        description: "Bill payment",
        source: "PAYMENT",
        lines: [
          { accountId: fixture.apAccountId, debitMinor: 30000, creditMinor: 0, supplierId: fixture.supplierId },
          { accountId: fixture.expenseAccountId, debitMinor: 0, creditMinor: 30000 },
        ],
      });

    const response = await request(app)
      .get(`/api/v1/suppliers/${fixture.supplierId}`)
      .set("Authorization", await authHeader());

    expect(response.body.balance_minor).toBe("20000");
  });

  it("rejects a journal line whose supplierId belongs to another tenant, with a precise 404", async () => {
    const fixture = await makeBalanceFixture();

    const otherTenantId = randomUUID();
    const foreignSupplierId = await withoutTenant(async (client) => {
      await client.query(
        `INSERT INTO tenants (id, name, type, base_currency) VALUES ($1, $2, 'BUSINESS', 'KES')`,
        [otherTenantId, `Other Tenant ${otherTenantId}`],
      );
      return withTenant(otherTenantId, async (tenantClient) => {
        const result = await tenantClient.query(
          `INSERT INTO suppliers (tenant_id, name) VALUES ($1, 'Foreign Supplier') RETURNING id`,
          [otherTenantId],
        );
        return result.rows[0]!.id as string;
      });
    });

    const response = await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        date: "2026-08-15",
        currency: "KES",
        description: "Cross-tenant supplier attribution attempt",
        source: "MANUAL",
        lines: [
          { accountId: fixture.expenseAccountId, debitMinor: 5000, creditMinor: 0 },
          { accountId: fixture.apAccountId, debitMinor: 0, creditMinor: 5000, supplierId: foreignSupplierId },
        ],
      });

    expect(response.status).toBe(404);
    expect(response.body.title).toBe("SUPPLIER_NOT_FOUND");
  });
});
