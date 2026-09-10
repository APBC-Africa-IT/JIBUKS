/**
 * HTTP-level tests for the guided Write Cheque endpoint.
 *
 * A cheque is the Cash Payments Book entry of manual bookkeeping: a
 * payment OUT. Its lines are heterogeneous by design -- some may clear a
 * supplier's outstanding bill (accountId = AP, supplierId set), others may
 * pay an expense directly (no party at all):
 *   Dr <line accountId>(s)
 *     Cr Bank (gross)
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

interface Fixture {
  supplierId: string;
  apAccountId: string;
  bankAccountId: string;
  expenseAccountId: string;
}

/** Seeds an open period plus a Bank (ASSET) account, an AP (LIABILITY)
 * account, an EXPENSE account, and a supplier -- everything one cheque
 * needs, whether it clears a bill, pays an expense directly, or both. */
async function makeFixture(): Promise<Fixture> {
  await withTenant(TEST_TENANT_ID, async (client) => {
    await client.query(
      `INSERT INTO periods (tenant_id, start_date, end_date) VALUES ($1, '2026-09-01', '2026-09-30')`,
      [TEST_TENANT_ID],
    );
  });

  const bank = await request(app)
    .post("/api/v1/accounts")
    .set("Authorization", await authHeader())
    .send({ code: randomUUID().slice(0, 8), name: "Bank Test", type: "ASSET" });
  const ap = await request(app)
    .post("/api/v1/accounts")
    .set("Authorization", await authHeader())
    .send({ code: randomUUID().slice(0, 8), name: "Accounts Payable Test", type: "LIABILITY" });
  const expense = await request(app)
    .post("/api/v1/accounts")
    .set("Authorization", await authHeader())
    .send({ code: randomUUID().slice(0, 8), name: "Office Supplies Test", type: "EXPENSE" });
  const supplier = await request(app)
    .post("/api/v1/suppliers")
    .set("Authorization", await authHeader())
    .send({ name: uniqueName("Write Cheque Supplier") });

  return {
    supplierId: supplier.body.id as string,
    apAccountId: ap.body.id as string,
    bankAccountId: bank.body.id as string,
    expenseAccountId: expense.body.id as string,
  };
}

describe("POST /api/v1/cheques", () => {
  it("posts Dr Accounts Payable / Cr Bank when clearing a supplier bill", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/cheques")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        bankAccountId: fixture.bankAccountId,
        date: "2026-09-15",
        currency: "KES",
        reference: "CHQ-0001",
        lines: [{ accountId: fixture.apAccountId, amountMinor: 100000, supplierId: fixture.supplierId }],
      });

    expect(response.status).toBe(201);
    expect(response.body.source).toBe("PAYMENT");
    expect(response.body.status).toBe("POSTED");
    expect(response.body.lines).toHaveLength(2);

    const apLine = response.body.lines.find((l: { account_id: string }) => l.account_id === fixture.apAccountId);
    const bankLine = response.body.lines.find((l: { account_id: string }) => l.account_id === fixture.bankAccountId);

    expect(apLine.debit_minor).toBe("100000");
    expect(apLine.supplier_id).toBe(fixture.supplierId);
    expect(bankLine.credit_minor).toBe("100000");
    expect(bankLine.debit_minor).toBe("0");
  });

  it("posts Dr Expense / Cr Bank when paying an expense directly, with no party at all", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/cheques")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        bankAccountId: fixture.bankAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [{ accountId: fixture.expenseAccountId, amountMinor: 25000, narrative: "Stationery" }],
      });

    expect(response.status).toBe(201);
    const expenseLine = response.body.lines.find((l: { account_id: string }) => l.account_id === fixture.expenseAccountId);
    expect(expenseLine.debit_minor).toBe("25000");
    expect(expenseLine.supplier_id).toBeNull();
    expect(expenseLine.customer_id).toBeNull();
  });

  it("splits one cheque across a bill-clearing line and a direct expense line", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/cheques")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        bankAccountId: fixture.bankAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [
          { accountId: fixture.apAccountId, amountMinor: 60000, supplierId: fixture.supplierId },
          { accountId: fixture.expenseAccountId, amountMinor: 15000 },
        ],
      });

    expect(response.status).toBe(201);
    expect(response.body.lines).toHaveLength(3);

    const bankLine = response.body.lines.find((l: { account_id: string }) => l.account_id === fixture.bankAccountId);
    expect(bankLine.credit_minor).toBe("75000");
  });

  it("rejects a line carrying both customerId and supplierId", async () => {
    const fixture = await makeFixture();

    const customer = await request(app)
      .post("/api/v1/customers")
      .set("Authorization", await authHeader())
      .send({ name: uniqueName("Irrelevant Customer") });

    const response = await request(app)
      .post("/api/v1/cheques")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        bankAccountId: fixture.bankAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [
          {
            accountId: fixture.apAccountId,
            amountMinor: 1000,
            supplierId: fixture.supplierId,
            customerId: customer.body.id,
          },
        ],
      });

    expect(response.status).toBe(400);
    expect(response.body.title).toBe("VALIDATION_ERROR");
  });

  it("rejects an empty lines array", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/cheques")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        bankAccountId: fixture.bankAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [],
      });

    expect(response.status).toBe(400);
    expect(response.body.title).toBe("VALIDATION_ERROR");
  });

  it("rejects a supplierId belonging to another tenant with a precise 404", async () => {
    const fixture = await makeFixture();

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
      .post("/api/v1/cheques")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        bankAccountId: fixture.bankAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [{ accountId: fixture.apAccountId, amountMinor: 1000, supplierId: foreignSupplierId }],
      });

    expect(response.status).toBe(404);
    expect(response.body.title).toBe("SUPPLIER_NOT_FOUND");
  });

  it("rejects a request with no Authorization header", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/cheques")
      .send({
        clientUuid: randomUUID(),
        bankAccountId: fixture.bankAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [{ accountId: fixture.expenseAccountId, amountMinor: 1000 }],
      });

    expect(response.status).toBe(401);
  });

  it("nets a cheque payment (debit) against a prior bill (credit) for the same supplier", async () => {
    const fixture = await makeFixture();

    await request(app)
      .post("/api/v1/bills")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        supplierId: fixture.supplierId,
        payableAccountId: fixture.apAccountId,
        date: "2026-09-05",
        currency: "KES",
        lines: [{ expenseAccountId: fixture.expenseAccountId, amountMinor: 100000 }],
      });

    await request(app)
      .post("/api/v1/cheques")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        bankAccountId: fixture.bankAccountId,
        date: "2026-09-20",
        currency: "KES",
        lines: [{ accountId: fixture.apAccountId, amountMinor: 60000, supplierId: fixture.supplierId }],
      });

    const response = await request(app)
      .get(`/api/v1/suppliers/${fixture.supplierId}`)
      .set("Authorization", await authHeader());

    expect(response.body.balance_minor).toBe("40000");
  });

  it("defaults description to 'Cheque payment' when omitted", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/cheques")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        bankAccountId: fixture.bankAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [{ accountId: fixture.expenseAccountId, amountMinor: 1000 }],
      });

    expect(response.body.description).toBe("Cheque payment");
  });
});
