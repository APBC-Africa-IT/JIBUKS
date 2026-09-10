/**
 * HTTP-level tests for the guided Credit Sale endpoint.
 *
 * A credit sale is the Sales Day Book entry of manual bookkeeping:
 *   Dr Accounts Receivable (gross, tagged to the customer)
 *     Cr Revenue line(s) (net)
 *     Cr Tax Payable (VAT, if any)
 * These tests check the composed journal, not the ledger's posting rules
 * themselves (those are covered by journals.test.ts / the ledger package).
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
  customerId: string;
  arAccountId: string;
  salesAccountId: string;
  otherSalesAccountId: string;
  vatAccountId: string;
}

/** Seeds an open period plus an AR account, two INCOME accounts, a VAT
 * (LIABILITY) account and a customer -- everything one credit sale needs. */
async function makeFixture(): Promise<Fixture> {
  await withTenant(TEST_TENANT_ID, async (client) => {
    await client.query(
      `INSERT INTO periods (tenant_id, start_date, end_date) VALUES ($1, '2026-09-01', '2026-09-30')`,
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
  const otherSales = await request(app)
    .post("/api/v1/accounts")
    .set("Authorization", await authHeader())
    .send({ code: randomUUID().slice(0, 8), name: "Service Revenue Test", type: "INCOME" });
  const vat = await request(app)
    .post("/api/v1/accounts")
    .set("Authorization", await authHeader())
    .send({ code: randomUUID().slice(0, 8), name: "VAT Payable Test", type: "LIABILITY" });
  const customer = await request(app)
    .post("/api/v1/customers")
    .set("Authorization", await authHeader())
    .send({ name: uniqueName("Credit Sale Customer") });

  return {
    customerId: customer.body.id as string,
    arAccountId: ar.body.id as string,
    salesAccountId: sales.body.id as string,
    otherSalesAccountId: otherSales.body.id as string,
    vatAccountId: vat.body.id as string,
  };
}

describe("POST /api/v1/credit-sales", () => {
  it("posts Dr Accounts Receivable / Cr Revenue for a single-line sale with no tax", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/credit-sales")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        customerId: fixture.customerId,
        receivableAccountId: fixture.arAccountId,
        date: "2026-09-15",
        currency: "KES",
        reference: "INV-0001",
        lines: [{ incomeAccountId: fixture.salesAccountId, amountMinor: 100000 }],
      });

    expect(response.status).toBe(201);
    expect(response.body.source).toBe("SALE");
    expect(response.body.status).toBe("POSTED");
    expect(response.body.lines).toHaveLength(2);

    const arLine = response.body.lines.find((l: { account_id: string }) => l.account_id === fixture.arAccountId);
    const salesLine = response.body.lines.find((l: { account_id: string }) => l.account_id === fixture.salesAccountId);

    expect(arLine.debit_minor).toBe("100000");
    expect(arLine.credit_minor).toBe("0");
    expect(arLine.customer_id).toBe(fixture.customerId);
    expect(salesLine.credit_minor).toBe("100000");
    expect(salesLine.debit_minor).toBe("0");
  });

  it("splits gross AR across multiple revenue lines plus a VAT line, per Kenyan 16% VAT", async () => {
    const fixture = await makeFixture();
    const netA = 100000; // KES 1,000.00
    const netB = 50000; // KES 500.00
    const vat = Math.round((netA + netB) * 0.16); // KES 24,000.00

    const response = await request(app)
      .post("/api/v1/credit-sales")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        customerId: fixture.customerId,
        receivableAccountId: fixture.arAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [
          { incomeAccountId: fixture.salesAccountId, amountMinor: netA, narrative: "Goods" },
          { incomeAccountId: fixture.otherSalesAccountId, amountMinor: netB, narrative: "Delivery service" },
        ],
        taxAccountId: fixture.vatAccountId,
        taxAmountMinor: vat,
      });

    expect(response.status).toBe(201);
    expect(response.body.lines).toHaveLength(4);

    const arLine = response.body.lines.find((l: { account_id: string }) => l.account_id === fixture.arAccountId);
    const vatLine = response.body.lines.find((l: { account_id: string }) => l.account_id === fixture.vatAccountId);
    const totalCredits = response.body.lines.reduce(
      (sum: number, l: { credit_minor: string }) => sum + Number(l.credit_minor),
      0,
    );

    expect(arLine.debit_minor).toBe(String(netA + netB + vat));
    expect(vatLine.credit_minor).toBe(String(vat));
    expect(totalCredits).toBe(netA + netB + vat);
  });

  it("rejects a non-zero taxAmountMinor with no taxAccountId", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/credit-sales")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        customerId: fixture.customerId,
        receivableAccountId: fixture.arAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [{ incomeAccountId: fixture.salesAccountId, amountMinor: 1000 }],
        taxAmountMinor: 160,
      });

    expect(response.status).toBe(400);
    expect(response.body.title).toBe("VALIDATION_ERROR");
  });

  it("rejects an empty lines array", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/credit-sales")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        customerId: fixture.customerId,
        receivableAccountId: fixture.arAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [],
      });

    expect(response.status).toBe(400);
    expect(response.body.title).toBe("VALIDATION_ERROR");
  });

  it("rejects a customerId belonging to another tenant with a precise 404", async () => {
    const fixture = await makeFixture();

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
      .post("/api/v1/credit-sales")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        customerId: foreignCustomerId,
        receivableAccountId: fixture.arAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [{ incomeAccountId: fixture.salesAccountId, amountMinor: 1000 }],
      });

    expect(response.status).toBe(404);
    expect(response.body.title).toBe("CUSTOMER_NOT_FOUND");
  });

  it("rejects a request with no Authorization header", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/credit-sales")
      .send({
        clientUuid: randomUUID(),
        customerId: fixture.customerId,
        receivableAccountId: fixture.arAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [{ incomeAccountId: fixture.salesAccountId, amountMinor: 1000 }],
      });

    expect(response.status).toBe(401);
  });

  it("updates the customer's balance_minor immediately, on the debit side", async () => {
    const fixture = await makeFixture();

    await request(app)
      .post("/api/v1/credit-sales")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        customerId: fixture.customerId,
        receivableAccountId: fixture.arAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [{ incomeAccountId: fixture.salesAccountId, amountMinor: 75000 }],
      });

    const response = await request(app)
      .get(`/api/v1/customers/${fixture.customerId}`)
      .set("Authorization", await authHeader());

    expect(response.body.balance_minor).toBe("75000");
  });
});
