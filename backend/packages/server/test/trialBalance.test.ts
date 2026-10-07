/**
 * HTTP-level tests for the Trial Balance endpoint (FR-TB-01).
 *
 * The ledger math itself (netting, natural sides, isBalanced) is already
 * covered by packages/ledger/test/trialBalance.test.ts -- this file only
 * proves the HTTP layer wires accounts + POSTED journal_lines into it
 * correctly for a real tenant.
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
  salesAccountId: string;
  rentAccountId: string;
}

/** Seeds an open period plus a Cash (ASSET), Sales (INCOME) and Rent
 * (EXPENSE) account -- everything a small trial balance needs. */
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
  const rent = await request(app)
    .post("/api/v1/accounts")
    .set("Authorization", await authHeader())
    .send({ code: randomUUID().slice(0, 8), name: "Rent Test", type: "EXPENSE" });

  return {
    cashAccountId: cash.body.id as string,
    salesAccountId: sales.body.id as string,
    rentAccountId: rent.body.id as string,
  };
}

describe("GET /api/v1/trial-balance", () => {
  it("returns a balanced trial balance reflecting POSTED journals only", async () => {
    const fixture = await makeFixture();

    await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        date: "2026-09-10",
        currency: "KES",
        description: "Cash sale",
        source: "CASHBOOK",
        lines: [
          { accountId: fixture.cashAccountId, debitMinor: 100000, creditMinor: 0 },
          { accountId: fixture.salesAccountId, debitMinor: 0, creditMinor: 100000 },
        ],
      });
    await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        date: "2026-09-12",
        currency: "KES",
        description: "Rent paid",
        source: "CASHBOOK",
        lines: [
          { accountId: fixture.rentAccountId, debitMinor: 30000, creditMinor: 0 },
          { accountId: fixture.cashAccountId, debitMinor: 0, creditMinor: 30000 },
        ],
      });

    const response = await request(app).get("/api/v1/trial-balance").set("Authorization", await authHeader());

    expect(response.status).toBe(200);
    expect(response.body.currency).toBe("KES");
    expect(response.body.isBalanced).toBe(true);
    expect(response.body.totalDebitMinor).toBe(response.body.totalCreditMinor);

    const cashRow = response.body.rows.find((r: { accountId: string }) => r.accountId === fixture.cashAccountId);
    const salesRow = response.body.rows.find((r: { accountId: string }) => r.accountId === fixture.salesAccountId);
    const rentRow = response.body.rows.find((r: { accountId: string }) => r.accountId === fixture.rentAccountId);

    expect(cashRow.balanceMinor).toBe(70000); // ASSET, debit-natured: 100000 - 30000
    expect(salesRow.balanceMinor).toBe(100000); // INCOME, credit-natured
    expect(rentRow.balanceMinor).toBe(30000); // EXPENSE, debit-natured
  });

  it("sorts rows by account code", async () => {
    const fixture = await makeFixture();

    await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        date: "2026-09-10",
        currency: "KES",
        description: "Cash sale",
        source: "CASHBOOK",
        lines: [
          { accountId: fixture.cashAccountId, debitMinor: 5000, creditMinor: 0 },
          { accountId: fixture.salesAccountId, debitMinor: 0, creditMinor: 5000 },
        ],
      });

    const response = await request(app).get("/api/v1/trial-balance").set("Authorization", await authHeader());
    const codes = response.body.rows.map((r: { accountCode: string }) => r.accountCode);
    const sorted = [...codes].sort((a, b) => a.localeCompare(b));

    expect(codes).toEqual(sorted);
  });

  it("as_of excludes journals dated after the cutoff", async () => {
    const fixture = await makeFixture();

    await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        date: "2026-09-05",
        currency: "KES",
        description: "Early sale",
        source: "CASHBOOK",
        lines: [
          { accountId: fixture.cashAccountId, debitMinor: 40000, creditMinor: 0 },
          { accountId: fixture.salesAccountId, debitMinor: 0, creditMinor: 40000 },
        ],
      });
    await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        date: "2026-09-25",
        currency: "KES",
        description: "Late sale",
        source: "CASHBOOK",
        lines: [
          { accountId: fixture.cashAccountId, debitMinor: 60000, creditMinor: 0 },
          { accountId: fixture.salesAccountId, debitMinor: 0, creditMinor: 60000 },
        ],
      });

    const cutoff = await request(app)
      .get("/api/v1/trial-balance")
      .query({ as_of: "2026-09-10" })
      .set("Authorization", await authHeader());
    const uncapped = await request(app).get("/api/v1/trial-balance").set("Authorization", await authHeader());

    const cutoffCash = cutoff.body.rows.find((r: { accountId: string }) => r.accountId === fixture.cashAccountId);
    const uncappedCash = uncapped.body.rows.find((r: { accountId: string }) => r.accountId === fixture.cashAccountId);

    expect(cutoffCash.balanceMinor).toBe(40000);
    expect(uncappedCash.balanceMinor).toBe(100000);
  });

  it("rejects a malformed as_of with a precise 400 validation error", async () => {
    await makeFixture();

    const response = await request(app)
      .get("/api/v1/trial-balance")
      .query({ as_of: "not-a-date" })
      .set("Authorization", await authHeader());

    expect(response.status).toBe(400);
    expect(response.body.title).toBe("VALIDATION_ERROR");
  });

  it("rejects a request with no Authorization header", async () => {
    const response = await request(app).get("/api/v1/trial-balance");

    expect(response.status).toBe(401);
  });
});
