/**
 * Sales receipts: cash sales as numbered documents (CS-000001), posted and
 * PAID on creation -- the Cash Sale screen and its receipt.
 *
 *   Dr deposit account (total) / Cr income (net) / Cr output VAT
 *
 * Dates are today (Africa/Nairobi) so the current period opens itself.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@jibuks/db";
import { createApp } from "../src/app.js";
import { listen } from "./testServer.js";
import { todayInNairobi } from "../src/modules/periods/service.js";
import { authHeader, TEST_TENANT_ID } from "./testAuth.js";

const app = await listen(createApp());
const today = todayInNairobi();

beforeAll(async () => {
  // Charging VAT needs a VAT-registered business.
  await withTenant(TEST_TENANT_ID, async (client) => {
    await client.query(`UPDATE tenants SET vat_registered = true WHERE id = $1`, [TEST_TENANT_ID]);
  });
});

afterAll(async () => {
  await closePool();
});

interface Fixture {
  cashAccountId: string;
  salesAccountId: string;
  serviceAccountId: string;
  vatAccountId: string;
  customerId: string;
  customerName: string;
}

async function auth() {
  return { Authorization: await authHeader() };
}

async function makeFixture(): Promise<Fixture> {
  const account = async (name: string, type: string) => {
    const response = await request(app)
      .post("/api/v1/accounts")
      .set(await auth())
      .send({ code: randomUUID().slice(0, 8), name, type });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.id as string;
  };
  const customerName = `Receipt Customer ${randomUUID().slice(0, 8)}`;
  const created = await request(app).post("/api/v1/customers").set(await auth()).send({ name: customerName });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return {
    cashAccountId: await account("Cash Test", "ASSET"),
    salesAccountId: await account("Sales Test", "INCOME"),
    serviceAccountId: await account("Service Revenue Test", "INCOME"),
    vatAccountId: await account("Output VAT Test", "LIABILITY"),
    customerId: created.body.id as string,
    customerName,
  };
}

function saleBody(f: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    clientUuid: randomUUID(),
    date: today,
    paymentMethod: "CASH",
    depositAccountId: f.cashAccountId,
    lines: [{ item: "Haircut", quantity: 1, unitPriceMinor: 30000, incomeAccountId: f.serviceAccountId }],
    ...overrides,
  };
}

async function createSale(body: object) {
  return request(app).post("/api/v1/sales-receipts").set(await auth()).send(body);
}

async function journal(journalId: string) {
  return withTenant(TEST_TENANT_ID, async (client) => {
    const header = await client.query<{ source: string; description: string; reference: string; status: string }>(
      `SELECT source, description, reference, status FROM journals WHERE id = $1`,
      [journalId],
    );
    const lines = await client.query<{
      account_id: string;
      debit_minor: string;
      credit_minor: string;
      customer_id: string | null;
    }>(`SELECT account_id, debit_minor, credit_minor, customer_id FROM journal_lines WHERE journal_id = $1`, [journalId]);
    return { ...header.rows[0]!, lines: lines.rows };
  });
}

describe("POST /api/v1/sales-receipts", () => {
  it("records the design's receipt: VAT-inclusive Haircut 300 + Shave 150 = 388 + VAT 62 = 450, walk-in, numbered and PAID", async () => {
    const f = await makeFixture();

    const response = await createSale(
      saleBody(f, {
        taxMode: "INCLUSIVE",
        messageToCustomer: "Thank you, karibu tena!",
        memo: "Chair 2",
        lines: [
          {
            item: "Haircut",
            quantity: 1,
            unitPriceMinor: 30000,
            incomeAccountId: f.serviceAccountId,
            taxRateBps: 1600,
            taxAccountId: f.vatAccountId,
          },
          {
            item: "Shave",
            description: "Hot towel",
            quantity: 1,
            unitPriceMinor: 15000,
            incomeAccountId: f.serviceAccountId,
            taxRateBps: 1600,
            taxAccountId: f.vatAccountId,
          },
        ],
      }),
    );

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const sale = response.body;
    expect(sale.number).toMatch(/^CS-\d{6,}$/);
    expect(sale).toMatchObject({
      status: "PAID",
      customer_id: null,
      customer_name: null,
      date: today,
      payment_method: "CASH",
      deposit_account_id: f.cashAccountId,
      tax_mode: "INCLUSIVE",
      subtotal_minor: "38793",
      tax_minor: "6207",
      total_minor: "45000",
      message_to_customer: "Thank you, karibu tena!",
      memo: "Chair 2",
    });
    expect(sale.created_at).toBeTruthy();
    expect(sale.lines).toHaveLength(2);
    expect(sale.lines[0]).toMatchObject({ item: "Haircut", description: null, quantity: "1.000", total_minor: "30000" });
    expect(sale.lines[1]).toMatchObject({ item: "Shave", description: "Hot towel", total_minor: "15000" });

    const posted = await journal(sale.journal_id);
    expect(posted).toMatchObject({ source: "CASHBOOK", status: "POSTED", reference: sale.number });
    expect(posted.description).toBe(`Cash sale ${sale.number}`);
    const debits = posted.lines.filter((l) => Number(l.debit_minor) > 0);
    expect(debits).toEqual([expect.objectContaining({ account_id: f.cashAccountId, debit_minor: "45000" })]);
    const credits = posted.lines.filter((l) => Number(l.credit_minor) > 0);
    const creditTo = (id: string) => credits.filter((l) => l.account_id === id).reduce((s, l) => s + Number(l.credit_minor), 0);
    expect(creditTo(f.serviceAccountId)).toBe(38793);
    expect(creditTo(f.vatAccountId)).toBe(6207);
    expect(posted.lines.every((l) => l.customer_id === null)).toBe(true);
  });

  it("numbers sales in order", async () => {
    // Other test files record cash sales in the same tenant at the same
    // time, so the next number is only known to be higher, not +1.
    const f = await makeFixture();
    const first = await createSale(saleBody(f));
    const second = await createSale(saleBody(f));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const n = (s: string) => Number(s.slice(3));
    expect(n(second.body.number)).toBeGreaterThan(n(first.body.number));
  });

  it("records a named customer without touching their balance", async () => {
    const f = await makeFixture();
    const response = await createSale(saleBody(f, { customerId: f.customerId }));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({ customer_id: f.customerId, customer_name: f.customerName });

    const customer = await request(app).get(`/api/v1/customers/${f.customerId}`).set(await auth());
    expect(customer.body.balance_minor).toBe("0");
  });

  it("adds VAT on top under EXCLUSIVE", async () => {
    const f = await makeFixture();
    const response = await createSale(
      saleBody(f, {
        taxMode: "EXCLUSIVE",
        lines: [
          {
            item: "Maize flour 2kg",
            quantity: 2,
            unitPriceMinor: 25000,
            incomeAccountId: f.salesAccountId,
            taxRateBps: 1600,
            taxAccountId: f.vatAccountId,
          },
          { item: "Delivery", quantity: 1, unitPriceMinor: 10000, incomeAccountId: f.serviceAccountId, taxRateBps: 0 },
        ],
      }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({ subtotal_minor: "60000", tax_minor: "8000", total_minor: "68000" });
  });

  it("defaults the M-Pesa deposit account from paymentMethod MPESA", async () => {
    const f = await makeFixture();
    const response = await createSale(saleBody(f, { paymentMethod: "MPESA", depositAccountId: undefined, reference: "QK7H2X9ABC" }));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const mpesa = await withTenant(TEST_TENANT_ID, async (client) => {
      const result = await client.query<{ id: string }>(`SELECT id FROM accounts WHERE system_key = 'MPESA'`);
      return result.rows[0]!.id;
    });
    expect(response.body).toMatchObject({ payment_method: "MPESA", deposit_account_id: mpesa, reference: "QK7H2X9ABC" });
  });

  it("requires depositAccountId for paymentMethod OTHER", async () => {
    const f = await makeFixture();
    const response = await createSale(saleBody(f, { paymentMethod: "OTHER", depositAccountId: undefined }));
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("depositAccountId");
  });

  it("rejects a tax rate under taxMode NONE, and a line without an item", async () => {
    const f = await makeFixture();
    const taxed = await createSale(
      saleBody(f, { lines: [{ item: "Soap", quantity: 1, unitPriceMinor: 5000, incomeAccountId: f.salesAccountId, taxRateBps: 1600 }] }),
    );
    expect(taxed.status).toBe(400);
    const noItem = await createSale(
      saleBody(f, { lines: [{ description: "Soap", quantity: 1, unitPriceMinor: 5000, incomeAccountId: f.salesAccountId }] }),
    );
    expect(noItem.status).toBe(400);
  });

  it("refuses a reused clientUuid without posting a second journal", async () => {
    const f = await makeFixture();
    const body = saleBody(f);
    const first = await createSale(body);
    expect(first.status).toBe(201);
    const again = await createSale(body);
    expect(again.status).toBe(409);

    // The refused attempt rolled back whole: no number used up (numbers
    // issued = sales stored) and only one journal for this clientUuid's sale.
    const counts = await withTenant(TEST_TENANT_ID, async (client) => {
      const result = await client.query<{ issued: number; stored: number; journals: number }>(
        `SELECT (SELECT last_value FROM invoice_number_sequences WHERE kind = 'CASH_SALE')::int AS issued,
                (SELECT count(*) FROM invoices WHERE kind = 'CASH_SALE')::int AS stored,
                (SELECT count(*) FROM journals WHERE reference = $1)::int AS journals`,
        [first.body.number],
      );
      return result.rows[0]!;
    });
    expect(counts.issued).toBe(counts.stored);
    expect(counts.journals).toBe(1);
  });
});

describe("GET /api/v1/sales-receipts", () => {
  it("returns a sale by id, lists sales by customer, and keeps them out of /invoices", async () => {
    const f = await makeFixture();
    const sale = (await createSale(saleBody(f, { customerId: f.customerId }))).body;

    const one = await request(app).get(`/api/v1/sales-receipts/${sale.id}`).set(await auth());
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ id: sale.id, number: sale.number, lines: [expect.objectContaining({ item: "Haircut" })] });

    const listed = await request(app).get(`/api/v1/sales-receipts?customer_id=${f.customerId}`).set(await auth());
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((s: { id: string }) => s.id)).toEqual([sale.id]);
    expect(listed.body.data[0].lines).toBeUndefined();

    const asInvoice = await request(app).get(`/api/v1/invoices/${sale.id}`).set(await auth());
    expect(asInvoice.status).toBe(404);
    const invoices = await request(app).get(`/api/v1/invoices?customer_id=${f.customerId}`).set(await auth());
    expect(invoices.body.data).toEqual([]);
  });

  it("does not find an invoice through /sales-receipts", async () => {
    const f = await makeFixture();
    const draft = await request(app)
      .post("/api/v1/invoices")
      .set(await auth())
      .send({
        clientUuid: randomUUID(),
        customerId: f.customerId,
        issueDate: today,
        receivableAccountId: f.cashAccountId,
        lines: [{ description: "Thing", quantity: 1, unitPriceMinor: 1000, incomeAccountId: f.salesAccountId }],
      });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const response = await request(app).get(`/api/v1/sales-receipts/${draft.body.id}`).set(await auth());
    expect(response.status).toBe(404);
  });
});
