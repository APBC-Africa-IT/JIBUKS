/**
 * HTTP-level tests for the guided Write Bill endpoint.
 *
 * A bill is the Purchases Day Book entry of manual bookkeeping, the
 * supplier-side mirror of Credit Sale:
 *   Dr Expense/Asset line(s) (net)
 *   Dr Input Tax (if any -- reclaimable, unlike a sale's tax credit)
 *     Cr Accounts Payable (gross, tagged to the supplier)
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
  expenseAccountId: string;
  otherExpenseAccountId: string;
  inputVatAccountId: string;
}

/** Seeds an open period plus an AP (LIABILITY) account, two EXPENSE
 * accounts, an Input VAT (ASSET) account, and a supplier -- everything one
 * bill needs. */
async function makeFixture(): Promise<Fixture> {
  await withTenant(TEST_TENANT_ID, async (client) => {
    await client.query(
      `INSERT INTO periods (tenant_id, start_date, end_date) VALUES ($1, '2026-09-01', '2026-09-30')`,
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
  const otherExpense = await request(app)
    .post("/api/v1/accounts")
    .set("Authorization", await authHeader())
    .send({ code: randomUUID().slice(0, 8), name: "Utilities Test", type: "EXPENSE" });
  const inputVat = await request(app)
    .post("/api/v1/accounts")
    .set("Authorization", await authHeader())
    .send({ code: randomUUID().slice(0, 8), name: "Input VAT Recoverable Test", type: "ASSET" });
  const supplier = await request(app)
    .post("/api/v1/suppliers")
    .set("Authorization", await authHeader())
    .send({ name: uniqueName("Write Bill Supplier") });

  return {
    supplierId: supplier.body.id as string,
    apAccountId: ap.body.id as string,
    expenseAccountId: expense.body.id as string,
    otherExpenseAccountId: otherExpense.body.id as string,
    inputVatAccountId: inputVat.body.id as string,
  };
}

describe("POST /api/v1/bills", () => {
  it("posts Dr Expense / Cr Accounts Payable for a single-line bill with no tax", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/bills")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        supplierId: fixture.supplierId,
        payableAccountId: fixture.apAccountId,
        date: "2026-09-15",
        currency: "KES",
        reference: "BILL-0001",
        lines: [{ expenseAccountId: fixture.expenseAccountId, amountMinor: 100000 }],
      });

    expect(response.status).toBe(201);
    expect(response.body.source).toBe("BILL");
    expect(response.body.status).toBe("POSTED");
    expect(response.body.lines).toHaveLength(2);

    const apLine = response.body.lines.find((l: { account_id: string }) => l.account_id === fixture.apAccountId);
    const expenseLine = response.body.lines.find((l: { account_id: string }) => l.account_id === fixture.expenseAccountId);

    expect(apLine.credit_minor).toBe("100000");
    expect(apLine.debit_minor).toBe("0");
    expect(apLine.supplier_id).toBe(fixture.supplierId);
    expect(expenseLine.debit_minor).toBe("100000");
    expect(expenseLine.credit_minor).toBe("0");
  });

  it("splits gross AP across multiple expense lines plus an input VAT line, per Kenyan 16% VAT", async () => {
    const fixture = await makeFixture();
    const netA = 100000;
    const netB = 50000;
    const vat = Math.round((netA + netB) * 0.16);

    const response = await request(app)
      .post("/api/v1/bills")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        supplierId: fixture.supplierId,
        payableAccountId: fixture.apAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [
          { expenseAccountId: fixture.expenseAccountId, amountMinor: netA, narrative: "Stock" },
          { expenseAccountId: fixture.otherExpenseAccountId, amountMinor: netB, narrative: "Electricity" },
        ],
        taxAccountId: fixture.inputVatAccountId,
        taxAmountMinor: vat,
      });

    expect(response.status).toBe(201);
    expect(response.body.lines).toHaveLength(4);

    const apLine = response.body.lines.find((l: { account_id: string }) => l.account_id === fixture.apAccountId);
    const vatLine = response.body.lines.find((l: { account_id: string }) => l.account_id === fixture.inputVatAccountId);
    const totalDebits = response.body.lines.reduce(
      (sum: number, l: { debit_minor: string }) => sum + Number(l.debit_minor),
      0,
    );

    expect(apLine.credit_minor).toBe(String(netA + netB + vat));
    expect(vatLine.debit_minor).toBe(String(vat));
    expect(totalDebits).toBe(netA + netB + vat);
  });

  it("rejects a non-zero taxAmountMinor with no taxAccountId", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/bills")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        supplierId: fixture.supplierId,
        payableAccountId: fixture.apAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [{ expenseAccountId: fixture.expenseAccountId, amountMinor: 1000 }],
        taxAmountMinor: 160,
      });

    expect(response.status).toBe(400);
    expect(response.body.title).toBe("VALIDATION_ERROR");
  });

  it("rejects an empty lines array", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/bills")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        supplierId: fixture.supplierId,
        payableAccountId: fixture.apAccountId,
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
      .post("/api/v1/bills")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        supplierId: foreignSupplierId,
        payableAccountId: fixture.apAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [{ expenseAccountId: fixture.expenseAccountId, amountMinor: 1000 }],
      });

    expect(response.status).toBe(404);
    expect(response.body.title).toBe("SUPPLIER_NOT_FOUND");
  });

  it("rejects a request with no Authorization header", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/bills")
      .send({
        clientUuid: randomUUID(),
        supplierId: fixture.supplierId,
        payableAccountId: fixture.apAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [{ expenseAccountId: fixture.expenseAccountId, amountMinor: 1000 }],
      });

    expect(response.status).toBe(401);
  });

  it("updates the supplier's balance_minor immediately, on the credit side", async () => {
    const fixture = await makeFixture();

    await request(app)
      .post("/api/v1/bills")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        supplierId: fixture.supplierId,
        payableAccountId: fixture.apAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [{ expenseAccountId: fixture.expenseAccountId, amountMinor: 75000 }],
      });

    const response = await request(app)
      .get(`/api/v1/suppliers/${fixture.supplierId}`)
      .set("Authorization", await authHeader());

    expect(response.body.balance_minor).toBe("75000");
  });
});
