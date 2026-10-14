/**
 * JE-000001 numbers on journals entered by hand (the Journal Entry
 * screen's Ref#). Journals posted by other modules and reversals stay
 * unnumbered -- they carry their document's number in `reference`.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@jibuks/db";
import { createApp } from "../src/app.js";
import { listen } from "./testServer.js";
import { todayInNairobi } from "../src/modules/periods/service.js";
import { authHeader, TEST_TENANT_ID } from "./testAuth.js";

const app = await listen(createApp());
const today = todayInNairobi();

afterAll(async () => {
  await closePool();
});

async function auth() {
  return { Authorization: await authHeader() };
}

async function account(name: string, type: string): Promise<string> {
  const response = await request(app)
    .post("/api/v1/accounts")
    .set(await auth())
    .send({ code: randomUUID().slice(0, 8), name, type });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.id as string;
}

async function manualJournal(bank: string, rent: string) {
  const response = await request(app)
    .post("/api/v1/journals")
    .set(await auth())
    .send({
      clientUuid: randomUUID(),
      date: today,
      currency: "KES",
      description: "Rent accrual",
      reference: "Landlord letter 12",
      lines: [
        { accountId: rent, debitMinor: 1000000, narrative: "October" },
        { accountId: bank, creditMinor: 1000000 },
      ],
    });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body;
}

describe("journal numbers", () => {
  it("number journals entered by hand, gapless and increasing, keeping the free-text reference", async () => {
    const bank = await account("Bank Test", "ASSET");
    const rent = await account("Rent Test", "EXPENSE");

    const first = await manualJournal(bank, rent);
    const second = await manualJournal(bank, rent);

    expect(first.number).toMatch(/^JE-\d{6,}$/);
    expect(first.reference).toBe("Landlord letter 12");
    expect(Number(second.number.slice(3))).toBeGreaterThan(Number(first.number.slice(3)));

    const fetched = await request(app).get(`/api/v1/journals/${first.id}`).set(await auth());
    expect(fetched.body.number).toBe(first.number);

    // Other files post journals at the same time, so gapless is checked as
    // "every number taken belongs to a stored journal".
    const counts = await withTenant(TEST_TENANT_ID, async (client) => {
      const result = await client.query<{ issued: number; stored: number }>(
        `SELECT (SELECT last_value FROM journal_number_sequences)::int AS issued,
                (SELECT count(*) FROM journals WHERE number IS NOT NULL)::int AS stored`,
      );
      return result.rows[0]!;
    });
    expect(counts.issued).toBe(counts.stored);
  });

  it("leave reversals and journals posted by other modules unnumbered", async () => {
    const bank = await account("Bank Test", "ASSET");
    const rent = await account("Rent Test", "EXPENSE");
    const income = await account("Sales Test", "INCOME");

    const journal = await manualJournal(bank, rent);
    const reversal = await request(app)
      .post(`/api/v1/journals/${journal.id}/reverse`)
      .set(await auth())
      .send({ reason: "Entered twice" });
    expect(reversal.status, JSON.stringify(reversal.body)).toBe(201);
    expect(reversal.body.number).toBeNull();

    const sale = await request(app)
      .post("/api/v1/sales-receipts")
      .set(await auth())
      .send({
        clientUuid: randomUUID(),
        paymentMethod: "BANK",
        depositAccountId: bank,
        lines: [{ item: "Haircut", quantity: 1, unitPriceMinor: 30000, incomeAccountId: income }],
      });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    const posted = await request(app).get(`/api/v1/journals/${sale.body.journal_id}`).set(await auth());
    expect(posted.body.number).toBeNull();
  });
});
