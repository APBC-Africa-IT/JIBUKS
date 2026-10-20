/**
 * Customer ledger: GET /customers/{id}/transactions (history with a running
 * balance), the last activity on GET /customers and /customers/{id}, and
 * GET /customers?q= search.
 *
 * Everything is dated today, so rows on the same date come back in the
 * order they were posted.
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

async function post(path: string, body: object = {}) {
  const response = await request(app).post(`/api/v1${path}`).set(await auth()).send(body);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  return response.body;
}

async function get(path: string) {
  return request(app).get(`/api/v1${path}`).set(await auth());
}

interface Fixture {
  customerId: string;
  customerName: string;
  arAccountId: string;
  salesAccountId: string;
  cashAccountId: string;
}

async function makeFixture(): Promise<Fixture> {
  const account = async (type: string) =>
    (await post("/accounts", { code: randomUUID().slice(0, 8), name: `Ledger ${type}`, type })).id as string;
  const customerName = `Ledger Customer ${randomUUID().slice(0, 8)}`;
  const phone = `+2547${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  return {
    customerId: (await post("/customers", { name: customerName, phone, paymentTermsDays: 30 })).id,
    customerName,
    arAccountId: await account("ASSET"),
    salesAccountId: await account("INCOME"),
    cashAccountId: await account("ASSET"),
  };
}

async function issueInvoice(f: Fixture, amountMinor: number) {
  const draft = await post("/invoices", {
    clientUuid: randomUUID(),
    customerId: f.customerId,
    receivableAccountId: f.arAccountId,
    issueDate: today,
    lines: [{ description: "Goods", quantity: 1, unitPriceMinor: amountMinor, incomeAccountId: f.salesAccountId }],
  });
  return post(`/invoices/${draft.id}/issue`);
}

/**
 * Credit sale 300 -> invoice A 1,000 -> invoice B 500 -> 200 paid on B by
 * M-Pesa -> credit note 100 on A -> invoice C 700 -> C cancelled.
 */
async function seedCustomer() {
  const f = await makeFixture();
  await post("/credit-sales", {
    clientUuid: randomUUID(),
    customerId: f.customerId,
    receivableAccountId: f.arAccountId,
    date: today,
    currency: "KES",
    lines: [{ incomeAccountId: f.salesAccountId, amountMinor: 30000 }],
  });
  const a = await issueInvoice(f, 100000);
  const b = await issueInvoice(f, 50000);
  await post(`/invoices/${b.id}/payments`, {
    clientUuid: randomUUID(),
    amountMinor: 20000,
    date: today,
    receivedAccountId: f.cashAccountId,
    method: "MPESA",
    reference: "QAB12CD34E",
  });
  const creditDraft = await post(`/invoices/${a.id}/credit-notes`, {
    clientUuid: randomUUID(),
    lines: [{ description: "Returned", quantity: 1, unitPriceMinor: 10000, incomeAccountId: f.salesAccountId }],
  });
  const creditNote = await post(`/invoices/${creditDraft.id}/issue`);
  const c = await issueInvoice(f, 70000);
  await post(`/invoices/${c.id}/cancel`, { reason: "Raised in error" });
  return { f, a, b, c, creditNote };
}

describe("GET /api/v1/customers/{id}/transactions", () => {
  it("lists every posted transaction, named by its document, with a running balance", async () => {
    const { f, a, b, c, creditNote } = await seedCustomer();

    const response = await get(`/customers/${f.customerId}/transactions`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      customer_id: f.customerId,
      customer_name: f.customerName,
      from: null,
      to: null,
      opening_balance_minor: "0",
      total_debit_minor: "250000",
      total_credit_minor: "100000",
      closing_balance_minor: "150000",
    });
    expect(response.body.data).toEqual([
      expect.objectContaining({ type: "CREDIT_SALE", document_id: null, debit_minor: "30000", credit_minor: "0", balance_minor: "30000" }),
      expect.objectContaining({ type: "INVOICE", document_id: a.id, document_number: a.number, document_kind: "INVOICE", balance_minor: "130000" }),
      expect.objectContaining({ type: "INVOICE", document_id: b.id, debit_minor: "50000", balance_minor: "180000" }),
      expect.objectContaining({
        type: "PAYMENT",
        document_kind: "CUSTOMER_PAYMENT",
        document_number: expect.stringMatching(/^PMT-\d{6,}$/),
        payment_method: "MPESA",
        reference: "QAB12CD34E",
        applied_invoices: [{ invoice_id: b.id, invoice_number: b.number, amount_minor: "20000" }],
        unapplied_minor: "0",
        credit_minor: "20000",
        balance_minor: "160000",
      }),
      expect.objectContaining({
        type: "CREDIT_NOTE",
        document_id: creditNote.id,
        document_number: creditNote.number,
        credited_invoice_id: a.id,
        credited_invoice_number: a.number,
        credit_minor: "10000",
        balance_minor: "150000",
      }),
      expect.objectContaining({ type: "INVOICE", document_id: c.id, debit_minor: "70000", balance_minor: "220000" }),
      expect.objectContaining({ type: "INVOICE_CANCELLED", document_id: c.id, credit_minor: "70000", balance_minor: "150000" }),
    ]);
  });

  it("closes on the same balance GET /customers/{id} returns", async () => {
    const { f } = await seedCustomer();

    const ledger = await get(`/customers/${f.customerId}/transactions`);
    const customer = await get(`/customers/${f.customerId}`);

    expect(ledger.body.closing_balance_minor).toBe(customer.body.balance_minor);
  });

  it("carries the balance before `from` as the opening balance", async () => {
    const { f } = await seedCustomer();

    const after = await get(`/customers/${f.customerId}/transactions?from=${addDays(today, 1)}`);
    const before = await get(`/customers/${f.customerId}/transactions?to=${addDays(today, -1)}`);
    const todayOnly = await get(`/customers/${f.customerId}/transactions?from=${today}&to=${today}`);

    expect(after.body).toMatchObject({ opening_balance_minor: "150000", closing_balance_minor: "150000", data: [] });
    expect(before.body).toMatchObject({ opening_balance_minor: "0", closing_balance_minor: "0", data: [] });
    expect(todayOnly.body.data).toHaveLength(7);
  });

  it("answers 404 for an unknown customer and 400 for from after to", async () => {
    const unknown = await get(`/customers/${randomUUID()}/transactions`);
    const backwards = await get(`/customers/${randomUUID()}/transactions?from=${today}&to=${addDays(today, -1)}`);

    expect(unknown.status).toBe(404);
    expect(backwards.status).toBe(400);
  });
});

describe("last activity on GET /api/v1/customers", () => {
  it("names the customer's latest transaction, and is null for a customer with none", async () => {
    const { f, c } = await seedCustomer();
    const quiet = await makeFixture();

    const list = await get("/customers");
    const one = await get(`/customers/${f.customerId}`);

    const row = list.body.data.find((r: { id: string }) => r.id === f.customerId);
    expect(row).toMatchObject({ balance_minor: "150000", last_activity: { type: "INVOICE_CANCELLED", date: today, document_number: c.number } });
    expect(row).not.toHaveProperty("last_activity_journal_id");
    expect(one.body.last_activity).toEqual(row.last_activity);
    expect(list.body.data.find((r: { id: string }) => r.id === quiet.customerId).last_activity).toBeNull();
  });

  it("names a payment, and respects as_of", async () => {
    const f = await makeFixture();
    const invoice = await issueInvoice(f, 40000);
    await post(`/invoices/${invoice.id}/payments`, {
      clientUuid: randomUUID(),
      amountMinor: 40000,
      date: today,
      receivedAccountId: f.cashAccountId,
    });

    const now = await get(`/customers/${f.customerId}`);
    const earlier = await get(`/customers/${f.customerId}?as_of=${addDays(today, -1)}`);

    expect(now.body).toMatchObject({
      balance_minor: "0",
      last_activity: { type: "PAYMENT", document_number: expect.stringMatching(/^PMT-\d{6,}$/) },
    });
    expect(earlier.body.last_activity).toBeNull();
  });
});

describe("GET /api/v1/customers?q=", () => {
  it("matches name, phone or email case-insensitively", async () => {
    const f = await makeFixture();
    const customer = (await get(`/customers/${f.customerId}`)).body;

    const byName = await get(`/customers?q=${encodeURIComponent(f.customerName.toUpperCase())}`);
    const byPhone = await get(`/customers?q=${encodeURIComponent(customer.phone)}`);

    expect(byName.body.data.map((r: { id: string }) => r.id)).toEqual([f.customerId]);
    expect(byPhone.body.data.map((r: { id: string }) => r.id)).toEqual([f.customerId]);
  });

  it("treats LIKE wildcards as text", async () => {
    await makeFixture();

    const response = await get(`/customers?q=${encodeURIComponent("%")}`);

    expect(response.status).toBe(200);
    for (const r of response.body.data as { name: string; phone: string | null; email: string | null }[]) {
      expect(`${r.name}${r.phone ?? ""}${r.email ?? ""}`).toContain("%");
    }
  });
});
