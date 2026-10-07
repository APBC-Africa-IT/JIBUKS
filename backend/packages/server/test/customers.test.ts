/**
 * HTTP-level tests for the customers module. Mirrors accounts.test.ts's
 * structure (customers/repository.ts intentionally mirrors
 * accounts/repository.ts's shape) with one addition: balance_minor is
 * driven by tagging a journal_lines row via customerId, not by posting to
 * the entity itself the way an account is posted to directly.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withoutTenant, withTenant } from "@jibuks/db";
import { createApp } from "../src/app.js";
import { listen } from "./testServer.js";
import { authHeader, TEST_TENANT_ID } from "./testAuth.js";

const app = await listen(createApp());

afterAll(async () => {
  await closePool();
});

function uniqueName(prefix: string): string {
  return `${prefix} ${randomUUID().slice(0, 8)}`;
}

describe("POST /api/v1/customers", () => {
  it("creates a customer and returns 201 with the full row", async () => {
    const name = uniqueName("Jane Trader");

    const response = await request(app)
      .post("/api/v1/customers")
      .set("Authorization", await authHeader())
      .send({ name, phone: "+254700000000", email: "jane@example.com" });

    expect(response.status).toBe(201);
    expect(response.body.name).toBe(name);
    expect(response.body.phone).toBe("+254700000000");
    expect(response.body.email).toBe("jane@example.com");
    expect(response.body.tenant_id).toBe(TEST_TENANT_ID);
    expect(response.body.is_active).toBe(true);
  });

  it("rejects a request with no Authorization header", async () => {
    const response = await request(app).post("/api/v1/customers").send({ name: uniqueName("No Auth") });

    expect(response.status).toBe(401);
  });

  it("rejects an empty name with a precise 400 validation error", async () => {
    const response = await request(app)
      .post("/api/v1/customers")
      .set("Authorization", await authHeader())
      .send({ name: "" });

    expect(response.status).toBe(400);
    expect(response.body.title).toBe("VALIDATION_ERROR");
    expect(response.body.errors[0].path).toBe("name");
  });

  it("records an audit log entry for the created customer", async () => {
    const response = await request(app)
      .post("/api/v1/customers")
      .set("Authorization", await authHeader())
      .send({ name: uniqueName("Audit Customer") });

    const customerId = response.body.id as string;

    const auditRows = await withTenant(TEST_TENANT_ID, async (client) => {
      const result = await client.query(`SELECT action, entity_id FROM audit_logs WHERE entity_id = $1`, [
        customerId,
      ]);
      return result.rows;
    });

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.action).toBe("CREATE");
  });
});

describe("GET /api/v1/customers", () => {
  it("lists customers for the authenticated tenant, excluding a second, separately-seeded tenant", async () => {
    const name = uniqueName("Own Tenant Customer");

    await request(app)
      .post("/api/v1/customers")
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
      await client.query(`INSERT INTO customers (tenant_id, name) VALUES ($1, 'Other Tenant Customer')`, [
        otherTenantId,
      ]);
    });

    const response = await request(app).get("/api/v1/customers").set("Authorization", await authHeader());

    expect(response.status).toBe(200);
    expect(response.body.data.some((c: { name: string }) => c.name === name)).toBe(true);
    expect(response.body.data.every((c: { tenant_id: string }) => c.tenant_id === TEST_TENANT_ID)).toBe(true);
  });
});

describe("GET /api/v1/customers/:id", () => {
  it("returns 404 for a customer that does not exist", async () => {
    const response = await request(app)
      .get(`/api/v1/customers/${randomUUID()}`)
      .set("Authorization", await authHeader());

    expect(response.status).toBe(404);
    expect(response.body.title).toBe("CUSTOMER_NOT_FOUND");
  });
});

describe("POST /api/v1/customers/:id/deactivate", () => {
  it("deactivates a customer, never deleting it", async () => {
    const created = await request(app)
      .post("/api/v1/customers")
      .set("Authorization", await authHeader())
      .send({ name: uniqueName("Deactivate Me") });

    const customerId = created.body.id as string;

    const response = await request(app)
      .post(`/api/v1/customers/${customerId}/deactivate`)
      .set("Authorization", await authHeader());

    expect(response.status).toBe(200);
    expect(response.body.is_active).toBe(false);

    const stillExists = await request(app)
      .get(`/api/v1/customers/${customerId}`)
      .set("Authorization", await authHeader());
    expect(stillExists.status).toBe(200);
    expect(stillExists.body.is_active).toBe(false);
  });
});

describe("POST /api/v1/customers/:id/reactivate", () => {
  it("reactivates a previously deactivated customer", async () => {
    const created = await request(app)
      .post("/api/v1/customers")
      .set("Authorization", await authHeader())
      .send({ name: uniqueName("Reactivate Me") });

    const customerId = created.body.id as string;

    await request(app).post(`/api/v1/customers/${customerId}/deactivate`).set("Authorization", await authHeader());

    const reactivated = await request(app)
      .post(`/api/v1/customers/${customerId}/reactivate`)
      .set("Authorization", await authHeader());

    expect(reactivated.status).toBe(200);
    expect(reactivated.body.is_active).toBe(true);
  });

  it("returns 404 when reactivating a customer that does not exist", async () => {
    const response = await request(app)
      .post(`/api/v1/customers/${randomUUID()}/reactivate`)
      .set("Authorization", await authHeader());

    expect(response.status).toBe(404);
    expect(response.body.title).toBe("CUSTOMER_NOT_FOUND");
  });
});

describe("GET /api/v1/customers (balance_minor)", () => {
  interface BalanceFixture {
    customerId: string;
    arAccountId: string;
    salesAccountId: string;
  }

  /** Seeds a period, an AR-like ASSET account, an INCOME account, and a
   * customer under TEST_TENANT_ID. Journals are posted over HTTP, tagging
   * the AR line with customerId -- exactly how a real "Credit Sale" would
   * work once that guided endpoint exists. */
  async function makeBalanceFixture(): Promise<BalanceFixture> {
    await withTenant(TEST_TENANT_ID, async (client) => {
      await client.query(
        `INSERT INTO periods (tenant_id, start_date, end_date) VALUES ($1, '2026-08-01', '2026-08-31')`,
        [TEST_TENANT_ID],
      );
    });

    const ar = await request(app)
      .post("/api/v1/accounts")
      .set("Authorization", await authHeader())
      .send({ code: randomUUID().slice(0, 8), name: "Accounts Receivable Test", type: "ASSET" });
    const sales = await request(app)
      .post("/api/v1/accounts")
      .set("Authorization", await authHeader())
      .send({ code: randomUUID().slice(0, 8), name: "Sales Test", type: "INCOME" });
    const customer = await request(app)
      .post("/api/v1/customers")
      .set("Authorization", await authHeader())
      .send({ name: uniqueName("Balance Customer") });

    return {
      customerId: customer.body.id as string,
      arAccountId: ar.body.id as string,
      salesAccountId: sales.body.id as string,
    };
  }

  it("computes balance_minor from journal lines tagged with customerId, on the debit side", async () => {
    const fixture = await makeBalanceFixture();

    await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        date: "2026-08-15",
        currency: "KES",
        description: "Credit sale",
        source: "MANUAL",
        lines: [
          { accountId: fixture.arAccountId, debitMinor: 150000, creditMinor: 0, customerId: fixture.customerId },
          { accountId: fixture.salesAccountId, debitMinor: 0, creditMinor: 150000 },
        ],
      });

    const response = await request(app)
      .get(`/api/v1/customers/${fixture.customerId}`)
      .set("Authorization", await authHeader());

    expect(response.status).toBe(200);
    expect(response.body.balance_minor).toBe("150000");
  });

  it("nets a payment (credit) against a prior sale (debit) for the same customer", async () => {
    const fixture = await makeBalanceFixture();

    await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        date: "2026-08-05",
        currency: "KES",
        description: "Credit sale",
        source: "MANUAL",
        lines: [
          { accountId: fixture.arAccountId, debitMinor: 100000, creditMinor: 0, customerId: fixture.customerId },
          { accountId: fixture.salesAccountId, debitMinor: 0, creditMinor: 100000 },
        ],
      });
    await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        date: "2026-08-20",
        currency: "KES",
        description: "Customer payment",
        source: "PAYMENT",
        lines: [
          { accountId: fixture.arAccountId, debitMinor: 0, creditMinor: 60000, customerId: fixture.customerId },
          { accountId: fixture.salesAccountId, debitMinor: 60000, creditMinor: 0 },
        ],
      });

    const response = await request(app)
      .get(`/api/v1/customers/${fixture.customerId}`)
      .set("Authorization", await authHeader());

    expect(response.body.balance_minor).toBe("40000");
  });

  it("rejects a journal line whose customerId belongs to another tenant, with a precise 404", async () => {
    const fixture = await makeBalanceFixture();

    const otherTenantId = randomUUID();
    const foreignCustomerId = await withoutTenant(async (client) => {
      await client.query(
        `INSERT INTO tenants (id, name, type, base_currency) VALUES ($1, $2, 'BUSINESS', 'KES')`,
        [otherTenantId, `Other Tenant ${otherTenantId}`],
      );
      return withTenant(otherTenantId, async (tenantClient) => {
        const result = await tenantClient.query(
          `INSERT INTO customers (tenant_id, name) VALUES ($1, 'Foreign Customer') RETURNING id`,
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
        description: "Cross-tenant customer attribution attempt",
        source: "MANUAL",
        lines: [
          { accountId: fixture.arAccountId, debitMinor: 5000, creditMinor: 0, customerId: foreignCustomerId },
          { accountId: fixture.salesAccountId, debitMinor: 0, creditMinor: 5000 },
        ],
      });

    expect(response.status).toBe(404);
    expect(response.body.title).toBe("CUSTOMER_NOT_FOUND");
  });


  it("refuses to change currency once the customer has transactions, with 422 PARTY_CURRENCY_LOCKED", async () => {
    const fixture = await makeBalanceFixture();
    await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        date: "2026-08-15",
        currency: "KES",
        description: "Currency lock",
        source: "MANUAL",
        lines: [
          { accountId: fixture.arAccountId, debitMinor: 1000, creditMinor: 0, customerId: fixture.customerId },
          { accountId: fixture.salesAccountId, debitMinor: 0, creditMinor: 1000 },
        ],
      });

    const changed = await request(app)
      .patch(`/api/v1/customers/${fixture.customerId}`)
      .set("Authorization", await authHeader())
      .send({ currency: "USD" });
    const unchanged = await request(app)
      .patch(`/api/v1/customers/${fixture.customerId}`)
      .set("Authorization", await authHeader())
      .send({ currency: null, paymentTermsDays: 14 });

    expect(changed.status).toBe(422);
    expect(changed.body.title).toBe("PARTY_CURRENCY_LOCKED");
    // Re-sending the current value (null = base currency) is not a change.
    expect(unchanged.status).toBe(200);
    expect(unchanged.body.payment_terms_days).toBe(14);
  });
});

describe("Customer tax identifier, payment terms, currency and credit limit (FR-AR-01)", () => {
  async function createCustomer(extra: Record<string, unknown> = {}) {
    const response = await request(app)
      .post("/api/v1/customers")
      .set("Authorization", await authHeader())
      .send({ name: uniqueName("Terms Customer"), ...extra });
    expect(response.status).toBe(201);
    return response.body as { id: string };
  }

  async function patchCustomer(id: string, body: Record<string, unknown>) {
    return request(app).patch(`/api/v1/customers/${id}`).set("Authorization", await authHeader()).send(body);
  }

  it("stores the new fields on create, normalising the KRA PIN to upper case", async () => {
    const response = await request(app)
      .post("/api/v1/customers")
      .set("Authorization", await authHeader())
      .send({ name: uniqueName("KRA Customer"), taxIdentifier: "  p051234567x ", paymentTermsDays: 30, currency: "KES", creditLimitMinor: 50000000 });

    expect(response.status).toBe(201);
    expect(response.body.tax_identifier).toBe("P051234567X");
    expect(response.body.payment_terms_days).toBe(30);
    expect(response.body.currency).toBe("KES");
    expect(response.body.credit_limit_minor).toBe("50000000");
  });

  it("defaults the new fields to null (currency null = the tenant's base currency)", async () => {
    const created = await createCustomer();
    const fetched = await request(app).get(`/api/v1/customers/${created.id}`).set("Authorization", await authHeader());

    expect(fetched.body.tax_identifier).toBeNull();
    expect(fetched.body.payment_terms_days).toBeNull();
    expect(fetched.body.currency).toBeNull();
  });

  it("rejects out-of-range payment terms, an unsupported currency and a malformed tax identifier", async () => {
    const badTerms = await request(app)
      .post("/api/v1/customers")
      .set("Authorization", await authHeader())
      .send({ name: uniqueName("Bad"), paymentTermsDays: 366 });
    const badCurrency = await request(app)
      .post("/api/v1/customers")
      .set("Authorization", await authHeader())
      .send({ name: uniqueName("Bad"), currency: "XYZ" });
    const badPin = await request(app)
      .post("/api/v1/customers")
      .set("Authorization", await authHeader())
      .send({ name: uniqueName("Bad"), taxIdentifier: "P05#1234" });

    expect(badTerms.status).toBe(400);
    expect(badCurrency.status).toBe(400);
    expect(badPin.status).toBe(400);
  });

  it("PATCH updates only the fields sent, clears a field with null, and audits the change", async () => {
    const created = await createCustomer({ phone: "+254711000000", taxIdentifier: "A000000001Z" });

    const response = await patchCustomer(created.id, { paymentTermsDays: 7, taxIdentifier: null });

    expect(response.status).toBe(200);
    expect(response.body.payment_terms_days).toBe(7);
    expect(response.body.tax_identifier).toBeNull();
    expect(response.body.phone).toBe("+254711000000");

    const audit = await withTenant(TEST_TENANT_ID, async (client) => {
      const result = await client.query(
        `SELECT before_state, after_state FROM audit_logs WHERE entity_type = 'customer' AND entity_id = $1 AND action = 'UPDATE'`,
        [created.id],
      );
      return result.rows;
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].before_state.tax_identifier).toBe("A000000001Z");
    expect(audit[0].after_state.tax_identifier).toBeNull();
  });

  it("PATCH rejects an empty body with 400 and an unknown customer with 404", async () => {
    const created = await createCustomer();

    const empty = await patchCustomer(created.id, {});
    const missing = await patchCustomer(randomUUID(), { name: "Nobody" });

    expect(empty.status).toBe(400);
    expect(missing.status).toBe(404);
    expect(missing.body.title).toBe("CUSTOMER_NOT_FOUND");
  });

  it("clears the credit limit with null and rejects a negative or fractional one", async () => {
    const created = await createCustomer({ creditLimitMinor: 100000 });

    const cleared = await patchCustomer(created.id, { creditLimitMinor: null });
    const negative = await patchCustomer(created.id, { creditLimitMinor: -1 });
    const fractional = await patchCustomer(created.id, { creditLimitMinor: 100.5 });

    expect(cleared.body.credit_limit_minor).toBeNull();
    expect(negative.status).toBe(400);
    expect(fractional.status).toBe(400);
  });
});
