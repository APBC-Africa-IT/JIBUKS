/**
 * HTTP-level tests for the Cash Flow endpoint (FR-RPT-01).
 *
 * The simple, direct-method version: net movement on the account(s) the
 * caller names as cash/cash-equivalents, over a date range. The caller
 * names the account(s) explicitly -- accounts carry no is-cash-equivalent
 * flag of their own, the same client-tells-the-server convention the
 * guided endpoints already use.
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

describe("GET /api/v1/cash-flow", () => {
  it("reports opening balance, inflow, outflow and closing balance for one account", async () => {
    const fixture = await makeFixture();

    // Before the window -- becomes the opening balance.
    await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        date: "2026-08-15",
        currency: "KES",
        description: "Opening cash sale",
        source: "CASHBOOK",
        lines: [
          { accountId: fixture.cashAccountId, debitMinor: 20000, creditMinor: 0 },
          { accountId: fixture.salesAccountId, debitMinor: 0, creditMinor: 20000 },
        ],
      });
    // Inside the window.
    await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        date: "2026-09-10",
        currency: "KES",
        description: "September cash sale",
        source: "CASHBOOK",
        lines: [
          { accountId: fixture.cashAccountId, debitMinor: 50000, creditMinor: 0 },
          { accountId: fixture.salesAccountId, debitMinor: 0, creditMinor: 50000 },
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
          { accountId: fixture.rentAccountId, debitMinor: 15000, creditMinor: 0 },
          { accountId: fixture.cashAccountId, debitMinor: 0, creditMinor: 15000 },
        ],
      });

    const response = await request(app)
      .get("/api/v1/cash-flow")
      .query({ accountId: fixture.cashAccountId, from: "2026-09-01", to: "2026-09-30" })
      .set("Authorization", await authHeader());

    expect(response.status).toBe(200);
    expect(response.body.currency).toBe("KES");

    const line = response.body.accounts[0];
    expect(line.accountId).toBe(fixture.cashAccountId);
    expect(line.openingBalanceMinor).toBe(20000);
    expect(line.inflowMinor).toBe(50000);
    expect(line.outflowMinor).toBe(15000);
    expect(line.closingBalanceMinor).toBe(55000); // 20000 + 50000 - 15000
    expect(response.body.netCashFlowMinor).toBe(35000); // 50000 - 15000
    expect(response.body.totalClosingBalanceMinor).toBe(55000);
  });

  it("supports multiple accountId query params, summing totals across accounts", async () => {
    const fixture = await makeFixture();
    const bank = await request(app)
      .post("/api/v1/accounts")
      .set("Authorization", await authHeader())
      .send({ code: randomUUID().slice(0, 8), name: "Bank Test", type: "ASSET" });
    const bankAccountId = bank.body.id as string;

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
          { accountId: fixture.cashAccountId, debitMinor: 10000, creditMinor: 0 },
          { accountId: fixture.salesAccountId, debitMinor: 0, creditMinor: 10000 },
        ],
      });
    await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send({
        clientUuid: randomUUID(),
        date: "2026-09-11",
        currency: "KES",
        description: "Bank sale",
        source: "CASHBOOK",
        lines: [
          { accountId: bankAccountId, debitMinor: 25000, creditMinor: 0 },
          { accountId: fixture.salesAccountId, debitMinor: 0, creditMinor: 25000 },
        ],
      });

    const response = await request(app)
      .get("/api/v1/cash-flow")
      .query({ accountId: [fixture.cashAccountId, bankAccountId], from: "2026-09-01", to: "2026-09-30" })
      .set("Authorization", await authHeader());

    expect(response.status).toBe(200);
    expect(response.body.accounts).toHaveLength(2);
    expect(response.body.totalInflowMinor).toBe(35000);
    expect(response.body.netCashFlowMinor).toBe(35000);
  });

  it("rejects an accountId that doesn't belong to this tenant with a precise 404", async () => {
    await makeFixture();

    const response = await request(app)
      .get("/api/v1/cash-flow")
      .query({ accountId: randomUUID(), from: "2026-09-01", to: "2026-09-30" })
      .set("Authorization", await authHeader());

    expect(response.status).toBe(404);
    expect(response.body.title).toBe("ACCOUNT_NOT_FOUND");
  });

  it("rejects a from date after the to date", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .get("/api/v1/cash-flow")
      .query({ accountId: fixture.cashAccountId, from: "2026-09-30", to: "2026-09-01" })
      .set("Authorization", await authHeader());

    expect(response.status).toBe(400);
    expect(response.body.title).toBe("VALIDATION_ERROR");
  });

  it("rejects a request missing accountId", async () => {
    await makeFixture();

    const response = await request(app)
      .get("/api/v1/cash-flow")
      .query({ from: "2026-09-01", to: "2026-09-30" })
      .set("Authorization", await authHeader());

    expect(response.status).toBe(400);
    expect(response.body.title).toBe("VALIDATION_ERROR");
  });

  it("rejects a request with no Authorization header", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .get("/api/v1/cash-flow")
      .query({ accountId: fixture.cashAccountId, from: "2026-09-01", to: "2026-09-30" });

    expect(response.status).toBe(401);
  });
});
