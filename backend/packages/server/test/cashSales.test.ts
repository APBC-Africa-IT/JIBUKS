/**
 * HTTP-level tests for the guided Cash Sale endpoint.
 *
 * A cash sale is the Cash Receipts Book entry of manual bookkeeping:
 *   Dr Cash/Bank (gross)
 *     Cr Revenue line(s) (net)
 *     Cr Tax Payable (VAT, if any)
 * Unlike Credit Sale, no customer/AR is involved at all.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@jibuks/db";
import { createApp } from "../src/app.js";
import { authHeader, TEST_TENANT_ID } from "./testAuth.js";

const app = createApp();

afterAll(async () => {
  await closePool();
});

interface Fixture {
  cashAccountId: string;
  salesAccountId: string;
  otherSalesAccountId: string;
  vatAccountId: string;
}

/** Seeds an open period plus a Cash (ASSET) account, two INCOME accounts,
 * and a VAT (LIABILITY) account -- everything one cash sale needs. */
async function makeFixture(): Promise<Fixture> {
  await withTenant(TEST_TENANT_ID, async (client) => {
    await client.query(
      `INSERT INTO periods (tenant_id, start_date, end_date) VALUES ($1, '2026-09-01', '2026-09-30')`,
      [TEST_TENANT_ID],
    );
  });

  const cash = await request(app)
    .post("/api/v1/accounts")
    .set("Authorization", await authHeader())
    .send({ code: randomUUID().slice(0, 8), name: "Cash Test", type: "ASSET" });
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

  return {
    cashAccountId: cash.body.id as string,
    salesAccountId: sales.body.id as string,
    otherSalesAccountId: otherSales.body.id as string,
    vatAccountId: vat.body.id as string,
  };
}

describe("POST /api/v1/cash-sales", () => {
  it("posts Dr Cash / Cr Revenue for a single-line sale with no tax", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/cash-sales")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        receivedAccountId: fixture.cashAccountId,
        date: "2026-09-15",
        currency: "KES",
        reference: "RCT-0001",
        lines: [{ incomeAccountId: fixture.salesAccountId, amountMinor: 50000 }],
      });

    expect(response.status).toBe(201);
    expect(response.body.source).toBe("CASHBOOK");
    expect(response.body.status).toBe("POSTED");
    expect(response.body.lines).toHaveLength(2);

    const cashLine = response.body.lines.find((l: { account_id: string }) => l.account_id === fixture.cashAccountId);
    const salesLine = response.body.lines.find((l: { account_id: string }) => l.account_id === fixture.salesAccountId);

    expect(cashLine.debit_minor).toBe("50000");
    expect(cashLine.credit_minor).toBe("0");
    expect(cashLine.customer_id).toBeNull();
    expect(salesLine.credit_minor).toBe("50000");
    expect(salesLine.debit_minor).toBe("0");
  });

  it("splits gross cash received across multiple revenue lines plus a VAT line, per Kenyan 16% VAT", async () => {
    const fixture = await makeFixture();
    const netA = 100000;
    const netB = 50000;
    const vat = Math.round((netA + netB) * 0.16);

    const response = await request(app)
      .post("/api/v1/cash-sales")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        receivedAccountId: fixture.cashAccountId,
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

    const cashLine = response.body.lines.find((l: { account_id: string }) => l.account_id === fixture.cashAccountId);
    const vatLine = response.body.lines.find((l: { account_id: string }) => l.account_id === fixture.vatAccountId);
    const totalCredits = response.body.lines.reduce(
      (sum: number, l: { credit_minor: string }) => sum + Number(l.credit_minor),
      0,
    );

    expect(cashLine.debit_minor).toBe(String(netA + netB + vat));
    expect(vatLine.credit_minor).toBe(String(vat));
    expect(totalCredits).toBe(netA + netB + vat);
  });

  it("rejects a non-zero taxAmountMinor with no taxAccountId", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/cash-sales")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        receivedAccountId: fixture.cashAccountId,
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
      .post("/api/v1/cash-sales")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        receivedAccountId: fixture.cashAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [],
      });

    expect(response.status).toBe(400);
    expect(response.body.title).toBe("VALIDATION_ERROR");
  });

  it("rejects a request with no Authorization header", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/cash-sales")
      .send({
        clientUuid: randomUUID(),
        receivedAccountId: fixture.cashAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [{ incomeAccountId: fixture.salesAccountId, amountMinor: 1000 }],
      });

    expect(response.status).toBe(401);
  });

  it("defaults description to 'Cash sale' when omitted", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/cash-sales")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        receivedAccountId: fixture.cashAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [{ incomeAccountId: fixture.salesAccountId, amountMinor: 1000 }],
      });

    expect(response.body.description).toBe("Cash sale");
  });
});
