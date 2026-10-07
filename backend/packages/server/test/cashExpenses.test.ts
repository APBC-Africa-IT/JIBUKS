/**
 * HTTP-level tests for the guided Cash Expense endpoint.
 *
 * A cash expense is the Cash Payments Book entry of manual bookkeeping,
 * the immediate-cash mirror of Write Bill:
 *   Dr Expense/Asset line(s) (net)
 *   Dr Input Tax (if any -- reclaimable)
 *     Cr Cash/Bank (gross)
 * Unlike Write Bill, no supplier/AP is involved -- payment happens on the
 * spot. Completes the micro-cashbook's sale + expense pair alongside Cash
 * Sale.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@jibuks/db";
import { createApp } from "../src/app.js";
import { listen } from "./testServer.js";
import { authHeader, TEST_TENANT_ID } from "./testAuth.js";

const app = await listen(createApp());

afterAll(async () => {
  await closePool();
});

interface Fixture {
  cashAccountId: string;
  expenseAccountId: string;
  otherExpenseAccountId: string;
  inputVatAccountId: string;
}

/** Seeds an open period plus a Cash (ASSET) account, two EXPENSE accounts,
 * and an Input VAT (ASSET) account -- everything one cash expense needs. */
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
  const expense = await request(app)
    .post("/api/v1/accounts")
    .set("Authorization", await authHeader())
    .send({ code: randomUUID().slice(0, 8), name: "General Expenses Test", type: "EXPENSE" });
  const otherExpense = await request(app)
    .post("/api/v1/accounts")
    .set("Authorization", await authHeader())
    .send({ code: randomUUID().slice(0, 8), name: "Transport Test", type: "EXPENSE" });
  const inputVat = await request(app)
    .post("/api/v1/accounts")
    .set("Authorization", await authHeader())
    .send({ code: randomUUID().slice(0, 8), name: "Input VAT Recoverable Test", type: "ASSET" });

  return {
    cashAccountId: cash.body.id as string,
    expenseAccountId: expense.body.id as string,
    otherExpenseAccountId: otherExpense.body.id as string,
    inputVatAccountId: inputVat.body.id as string,
  };
}

describe("POST /api/v1/cash-expenses", () => {
  it("posts Dr Expense / Cr Cash for a single-line expense with no tax", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/cash-expenses")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        paidAccountId: fixture.cashAccountId,
        date: "2026-09-15",
        currency: "KES",
        reference: "EXP-0001",
        lines: [{ expenseAccountId: fixture.expenseAccountId, amountMinor: 5000 }],
      });

    expect(response.status).toBe(201);
    expect(response.body.source).toBe("CASHBOOK");
    expect(response.body.status).toBe("POSTED");
    expect(response.body.lines).toHaveLength(2);

    const cashLine = response.body.lines.find((l: { account_id: string }) => l.account_id === fixture.cashAccountId);
    const expenseLine = response.body.lines.find(
      (l: { account_id: string }) => l.account_id === fixture.expenseAccountId,
    );

    expect(cashLine.credit_minor).toBe("5000");
    expect(cashLine.debit_minor).toBe("0");
    expect(expenseLine.debit_minor).toBe("5000");
    expect(expenseLine.credit_minor).toBe("0");
  });

  it("splits gross cash paid across multiple expense lines plus an input VAT line, per Kenyan 16% VAT", async () => {
    const fixture = await makeFixture();
    const netA = 10000;
    const netB = 5000;
    const vat = Math.round((netA + netB) * 0.16);

    const response = await request(app)
      .post("/api/v1/cash-expenses")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        paidAccountId: fixture.cashAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [
          { expenseAccountId: fixture.expenseAccountId, amountMinor: netA, narrative: "Airtime" },
          { expenseAccountId: fixture.otherExpenseAccountId, amountMinor: netB, narrative: "Matatu fare" },
        ],
        taxAccountId: fixture.inputVatAccountId,
        taxAmountMinor: vat,
      });

    expect(response.status).toBe(201);
    expect(response.body.lines).toHaveLength(4);

    const cashLine = response.body.lines.find((l: { account_id: string }) => l.account_id === fixture.cashAccountId);
    const vatLine = response.body.lines.find(
      (l: { account_id: string }) => l.account_id === fixture.inputVatAccountId,
    );
    const totalDebits = response.body.lines.reduce(
      (sum: number, l: { debit_minor: string }) => sum + Number(l.debit_minor),
      0,
    );

    expect(cashLine.credit_minor).toBe(String(netA + netB + vat));
    expect(vatLine.debit_minor).toBe(String(vat));
    expect(totalDebits).toBe(netA + netB + vat);
  });

  it("rejects a non-zero taxAmountMinor with no taxAccountId", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/cash-expenses")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        paidAccountId: fixture.cashAccountId,
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
      .post("/api/v1/cash-expenses")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        paidAccountId: fixture.cashAccountId,
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
      .post("/api/v1/cash-expenses")
      .send({
        clientUuid: randomUUID(),
        paidAccountId: fixture.cashAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [{ expenseAccountId: fixture.expenseAccountId, amountMinor: 1000 }],
      });

    expect(response.status).toBe(401);
  });

  it("defaults description to 'Cash expense' when omitted", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/cash-expenses")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        paidAccountId: fixture.cashAccountId,
        date: "2026-09-15",
        currency: "KES",
        lines: [{ expenseAccountId: fixture.expenseAccountId, amountMinor: 1000 }],
      });

    expect(response.body.description).toBe("Cash expense");
  });
});
