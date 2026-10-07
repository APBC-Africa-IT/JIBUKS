/**
 * HTTP-level tests for the Profit & Loss endpoint (FR-RPT-01).
 *
 * Unlike Trial Balance's cumulative as_of snapshot, P&L is scoped to a
 * date range and only ever shows INCOME/EXPENSE accounts.
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

describe("GET /api/v1/profit-and-loss", () => {
  it("nets income and expenses within the date range into a net profit", async () => {
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

    const response = await request(app)
      .get("/api/v1/profit-and-loss")
      .query({ from: "2026-09-01", to: "2026-09-30" })
      .set("Authorization", await authHeader());

    expect(response.status).toBe(200);
    expect(response.body.currency).toBe("KES");

    const salesLine = response.body.income.find((l: { accountId: string }) => l.accountId === fixture.salesAccountId);
    const rentLine = response.body.expenses.find((l: { accountId: string }) => l.accountId === fixture.rentAccountId);
    const cashInReports = [...response.body.income, ...response.body.expenses].find(
      (l: { accountId: string }) => l.accountId === fixture.cashAccountId,
    );

    expect(salesLine.amountMinor).toBe(100000);
    expect(rentLine.amountMinor).toBe(30000);
    expect(cashInReports).toBeUndefined(); // ASSET accounts never appear in P&L
  });

  it("excludes journals dated outside the requested range", async () => {
    const fixture = await makeFixture();

    await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        date: "2026-08-15",
        currency: "KES",
        description: "August sale",
        source: "CASHBOOK",
        lines: [
          { accountId: fixture.cashAccountId, debitMinor: 20000, creditMinor: 0 },
          { accountId: fixture.salesAccountId, debitMinor: 0, creditMinor: 20000 },
        ],
      });
    await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        date: "2026-09-15",
        currency: "KES",
        description: "September sale",
        source: "CASHBOOK",
        lines: [
          { accountId: fixture.cashAccountId, debitMinor: 50000, creditMinor: 0 },
          { accountId: fixture.salesAccountId, debitMinor: 0, creditMinor: 50000 },
        ],
      });

    const response = await request(app)
      .get("/api/v1/profit-and-loss")
      .query({ from: "2026-09-01", to: "2026-09-30" })
      .set("Authorization", await authHeader());

    const salesLine = response.body.income.find((l: { accountId: string }) => l.accountId === fixture.salesAccountId);
    expect(salesLine.amountMinor).toBe(50000);
  });

  it("rejects a from date after the to date", async () => {
    await makeFixture();

    const response = await request(app)
      .get("/api/v1/profit-and-loss")
      .query({ from: "2026-09-30", to: "2026-09-01" })
      .set("Authorization", await authHeader());

    expect(response.status).toBe(400);
    expect(response.body.title).toBe("VALIDATION_ERROR");
  });

  it("rejects a request missing the required from/to params", async () => {
    await makeFixture();

    const response = await request(app).get("/api/v1/profit-and-loss").set("Authorization", await authHeader());

    expect(response.status).toBe(400);
    expect(response.body.title).toBe("VALIDATION_ERROR");
  });

  it("rejects a request with no Authorization header", async () => {
    const response = await request(app)
      .get("/api/v1/profit-and-loss")
      .query({ from: "2026-09-01", to: "2026-09-30" });

    expect(response.status).toBe(401);
  });
});
