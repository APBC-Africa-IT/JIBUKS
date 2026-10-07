/**
 * Customer aging (FR-AR-04): open invoice amounts by days past due, with
 * non-invoice balances shown apart, and the per-customer drill-down.
 *
 * Invoices are dated today and the report is asked for at later as-of
 * dates, so ageing needs no backdated periods.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@jibuks/db";
import { createApp } from "../src/app.js";
import { listen } from "./testServer.js";
import { todayInNairobi } from "../src/modules/periods/service.js";
import { authHeader } from "./testAuth.js";

const app = await listen(createApp());
const today = todayInNairobi();

afterAll(async () => {
  await closePool();
});

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function auth() {
  return { Authorization: await authHeader() };
}

async function post(path: string, body: object) {
  const response = await request(app).post(`/api/v1${path}`).set(await auth()).send(body);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  return response.body;
}

async function aging(query: string) {
  return request(app).get(`/api/v1/receivables-aging?${query}`).set(await auth());
}

interface Fixture {
  customerId: string;
  arAccountId: string;
  salesAccountId: string;
  cashAccountId: string;
}

async function makeFixture(): Promise<Fixture> {
  const account = async (type: string) =>
    (await post("/accounts", { code: randomUUID().slice(0, 8), name: `Aging ${type}`, type })).id as string;
  return {
    customerId: (await post("/customers", { name: `Aging Customer ${randomUUID().slice(0, 8)}`, paymentTermsDays: 30 })).id,
    arAccountId: await account("ASSET"),
    salesAccountId: await account("INCOME"),
    cashAccountId: await account("ASSET"),
  };
}

async function issueInvoice(f: Fixture, amountMinor: number, extra: Record<string, unknown> = {}) {
  const draft = await post("/invoices", {
    clientUuid: randomUUID(),
    customerId: f.customerId,
    receivableAccountId: f.arAccountId,
    issueDate: today,
    lines: [{ description: "Goods", quantity: 1, unitPriceMinor: amountMinor, incomeAccountId: f.salesAccountId }],
    ...extra,
  });
  return post(`/invoices/${draft.id}/issue`, {});
}

/**
 * One customer with: A 1,000.00 due in 30 days; B 500.00 due today with
 * 200.00 paid; a cancelled 700.00; and a 300.00 credit sale (no invoice).
 */
async function seedCustomer() {
  const f = await makeFixture();
  const a = await issueInvoice(f, 100000);
  const b = await issueInvoice(f, 50000, { dueDate: today });
  await post(`/invoices/${b.id}/payments`, {
    clientUuid: randomUUID(),
    amountMinor: 20000,
    date: today,
    receivedAccountId: f.cashAccountId,
  });
  const cancelled = await issueInvoice(f, 70000);
  await post(`/invoices/${cancelled.id}/cancel`, { reason: "Raised in error" });
  await post("/credit-sales", {
    clientUuid: randomUUID(),
    customerId: f.customerId,
    receivableAccountId: f.arAccountId,
    date: today,
    currency: "KES",
    lines: [{ incomeAccountId: f.salesAccountId, amountMinor: 30000 }],
  });
  return { f, a, b };
}

describe("GET /api/v1/receivables-aging", () => {
  it("buckets each open invoice by days past due, and keeps non-invoice balances apart", async () => {
    const { f } = await seedCustomer();

    const later = await aging(`as_of=${addDays(today, 45)}`);
    const now = await aging(`as_of=${today}`);

    expect(later.status).toBe(200);
    expect(later.body).toMatchObject({
      as_of: addDays(today, 45),
      currency: "KES",
      buckets: ["CURRENT", "DAYS_1_30", "DAYS_31_60", "DAYS_61_90", "DAYS_OVER_90"],
    });
    const row = later.body.rows.find((r: { customer_id: string }) => r.customer_id === f.customerId);
    // A is 15 days late, B (300.00 left) 45 days late; the cancelled one is gone.
    expect(row).toMatchObject({
      current_minor: "0",
      days_1_30_minor: "100000",
      days_31_60_minor: "30000",
      days_61_90_minor: "0",
      days_over_90_minor: "0",
      invoiced_minor: "130000",
      not_invoiced_minor: "30000",
      balance_minor: "160000",
    });

    const nowRow = now.body.rows.find((r: { customer_id: string }) => r.customer_id === f.customerId);
    expect(nowRow).toMatchObject({ current_minor: "130000", days_1_30_minor: "0", balance_minor: "160000" });
  });

  it("totals equal the sum of the rows, and a row's buckets plus not-invoiced equal its balance", async () => {
    await seedCustomer();

    const report = await aging(`as_of=${addDays(today, 100)}`);

    const fields = [
      "current_minor",
      "days_1_30_minor",
      "days_31_60_minor",
      "days_61_90_minor",
      "days_over_90_minor",
      "invoiced_minor",
      "not_invoiced_minor",
      "balance_minor",
    ];
    for (const field of fields) {
      const sum = report.body.rows.reduce((acc: number, r: Record<string, string>) => acc + Number(r[field]), 0);
      expect(Number(report.body.totals[field]), field).toBe(sum);
    }
    for (const r of report.body.rows as Record<string, string>[]) {
      const buckets = fields.slice(0, 5).reduce((acc, field) => acc + Number(r[field]), 0);
      expect(buckets).toBe(Number(r["invoiced_minor"]));
      expect(buckets + Number(r["not_invoiced_minor"])).toBe(Number(r["balance_minor"]));
    }
  });

  it("leaves out a customer whose invoices weren't issued yet at the as-of date", async () => {
    const { f } = await seedCustomer();

    const before = await aging(`as_of=${addDays(today, -1)}`);

    expect(before.body.rows.find((r: { customer_id: string }) => r.customer_id === f.customerId)).toBeUndefined();
  });

  it("drills down to one customer's open invoices, oldest due first", async () => {
    const { f, a, b } = await seedCustomer();

    const detail = await aging(`as_of=${addDays(today, 45)}&customer_id=${f.customerId}`);

    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      customer_id: f.customerId,
      invoiced_minor: "130000",
      not_invoiced_minor: "30000",
      balance_minor: "160000",
    });
    expect(detail.body.invoices).toEqual([
      expect.objectContaining({ id: b.id, number: b.number, days_past_due: 45, bucket: "DAYS_31_60", open_minor: "30000" }),
      expect.objectContaining({ id: a.id, number: a.number, days_past_due: 15, bucket: "DAYS_1_30", open_minor: "100000" }),
    ]);
  });

  it("answers 404 for an unknown customer and 400 for a bad date", async () => {
    const unknown = await aging(`customer_id=${randomUUID()}`);
    const badDate = await aging("as_of=2026-13-40");

    expect(unknown.status).toBe(404);
    expect(badDate.status).toBe(400);
  });
});
