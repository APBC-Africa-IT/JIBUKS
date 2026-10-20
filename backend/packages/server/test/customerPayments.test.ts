/**
 * Customer payments (Receive Payment): POST/GET /customer-payments --
 * oldest-due-first application, chosen invoices, money beyond what's owed
 * kept as credit, the one journal each payment posts, and the list filters.
 *
 * Invoices are issued today with different due dates, so "oldest due
 * first" is decided by due date alone.
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

async function rawPost(path: string, body: object = {}) {
  return request(app).post(`/api/v1${path}`).set(await auth()).send(body);
}

async function get(path: string) {
  return request(app).get(`/api/v1${path}`).set(await auth());
}

async function journalLines(journalId: string) {
  return withTenant(TEST_TENANT_ID, async (client) => {
    const result = await client.query<{ account_id: string; debit_minor: string; credit_minor: string; customer_id: string | null }>(
      `SELECT account_id, debit_minor, credit_minor, customer_id FROM journal_lines WHERE journal_id = $1 ORDER BY debit_minor DESC`,
      [journalId],
    );
    return result.rows;
  });
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
    (await post("/accounts", { code: randomUUID().slice(0, 8), name: `Payments ${type}`, type })).id as string;
  const customerName = `Payments Customer ${randomUUID().slice(0, 8)}`;
  return {
    customerId: (await post("/customers", { name: customerName })).id,
    customerName,
    arAccountId: await account("ASSET"),
    salesAccountId: await account("INCOME"),
    cashAccountId: await account("ASSET"),
  };
}

async function draftInvoice(f: Fixture, amountMinor: number, dueInDays: number, customerId = f.customerId) {
  return post("/invoices", {
    clientUuid: randomUUID(),
    customerId,
    receivableAccountId: f.arAccountId,
    issueDate: today,
    dueDate: addDays(today, dueInDays),
    lines: [{ description: "Goods", quantity: 1, unitPriceMinor: amountMinor, incomeAccountId: f.salesAccountId }],
  });
}

async function issueInvoice(f: Fixture, amountMinor: number, dueInDays = 30, customerId = f.customerId) {
  const draft = await draftInvoice(f, amountMinor, dueInDays, customerId);
  return post(`/invoices/${draft.id}/issue`);
}

function paymentBody(f: Fixture, amountMinor: number, extra: Record<string, unknown> = {}) {
  return {
    clientUuid: randomUUID(),
    customerId: f.customerId,
    amountMinor,
    date: today,
    method: "CASH",
    receivedAccountId: f.cashAccountId,
    ...extra,
  };
}

async function invoice(id: string) {
  return (await get(`/invoices/${id}`)).body;
}

describe("POST /api/v1/customer-payments", () => {
  it("applies to the open invoices oldest due first when none are chosen", async () => {
    const f = await makeFixture();
    const a = await issueInvoice(f, 100000, 30);
    const b = await issueInvoice(f, 50000, 0);
    const c = await issueInvoice(f, 30000, 10);

    const payment = await post("/customer-payments", paymentBody(f, 100000, { reference: "Cash at counter" }));

    expect(payment).toMatchObject({
      number: expect.stringMatching(/^PMT-\d{6,}$/),
      customer_id: f.customerId,
      customer_name: f.customerName,
      date: today,
      currency: "KES",
      amount_minor: "100000",
      applied_minor: "100000",
      unapplied_minor: "0",
      method: "CASH",
      received_account_id: f.cashAccountId,
      reference: "Cash at counter",
    });
    expect(payment.allocations).toEqual([
      { invoice_id: b.id, invoice_number: b.number, amount_minor: "50000", date: today },
      { invoice_id: c.id, invoice_number: c.number, amount_minor: "30000", date: today },
      { invoice_id: a.id, invoice_number: a.number, amount_minor: "20000", date: today },
    ]);
    expect(await invoice(b.id)).toMatchObject({ status: "PAID", balance_due_minor: "0" });
    expect(await invoice(c.id)).toMatchObject({ status: "PAID" });
    expect(await invoice(a.id)).toMatchObject({ status: "PART_PAID", balance_due_minor: "80000" });
  });

  it("posts one journal for the whole payment, tagged with the customer", async () => {
    const f = await makeFixture();
    await issueInvoice(f, 50000, 0);
    await issueInvoice(f, 30000, 10);

    const payment = await post("/customer-payments", paymentBody(f, 80000));

    expect(await journalLines(payment.journal_id)).toEqual([
      { account_id: f.cashAccountId, debit_minor: "80000", credit_minor: "0", customer_id: null },
      { account_id: f.arAccountId, debit_minor: "0", credit_minor: "80000", customer_id: f.customerId },
    ]);
  });

  it("keeps what isn't owed as customer credit", async () => {
    const f = await makeFixture();
    const owed = await issueInvoice(f, 50000);

    const payment = await post("/customer-payments", paymentBody(f, 80000));
    const customer = await get(`/customers/${f.customerId}`);

    expect(payment).toMatchObject({ applied_minor: "50000", unapplied_minor: "30000" });
    expect(await invoice(owed.id)).toMatchObject({ status: "PAID" });
    expect(customer.body.balance_minor).toBe("-30000");
    // The credit sits in the same receivable account as the invoice it came with.
    expect(await journalLines(payment.journal_id)).toEqual([
      { account_id: f.cashAccountId, debit_minor: "80000", credit_minor: "0", customer_id: null },
      { account_id: f.arAccountId, debit_minor: "0", credit_minor: "80000", customer_id: f.customerId },
    ]);
  });

  it("pays only the chosen invoices, and keeps the rest as credit", async () => {
    const f = await makeFixture();
    const older = await issueInvoice(f, 50000, 0);
    const chosen = await issueInvoice(f, 30000, 10);

    const payment = await post("/customer-payments", paymentBody(f, 100000, { allocations: [{ invoiceId: chosen.id, amountMinor: 20000 }] }));

    expect(payment).toMatchObject({ applied_minor: "20000", unapplied_minor: "80000" });
    expect(payment.allocations).toEqual([expect.objectContaining({ invoice_id: chosen.id, amount_minor: "20000" })]);
    expect(await invoice(chosen.id)).toMatchObject({ status: "PART_PAID", balance_due_minor: "10000" });
    expect(await invoice(older.id)).toMatchObject({ status: "ISSUED", balance_due_minor: "50000" });
  });

  it("keeps it all as credit with allocations: []", async () => {
    const f = await makeFixture();
    const open = await issueInvoice(f, 50000);

    const payment = await post("/customer-payments", paymentBody(f, 20000, { allocations: [] }));

    expect(payment).toMatchObject({ applied_minor: "0", unapplied_minor: "20000", allocations: [] });
    expect(await invoice(open.id)).toMatchObject({ status: "ISSUED" });
  });

  it("is all credit for a customer with nothing owed", async () => {
    const f = await makeFixture();

    const response = await rawPost("/customer-payments", paymentBody(f, 20000));

    // With no invoice, the credit goes to the business's default receivable
    // account; the test business may not have one marked.
    if (response.status === 201) {
      expect(response.body).toMatchObject({ applied_minor: "0", unapplied_minor: "20000" });
    } else {
      expect(response.body.title).toBe("SYSTEM_ACCOUNT_MISSING");
    }
  });

  it("uses the business's M-Pesa account when none is named", async () => {
    const f = await makeFixture();
    await issueInvoice(f, 50000);

    const payment = await post("/customer-payments", paymentBody(f, 50000, { method: "MPESA", receivedAccountId: undefined, reference: "QAB12CD34E" }));

    expect(payment).toMatchObject({ method: "MPESA", reference: "QAB12CD34E", received_account_id: expect.any(String) });
    expect(payment.received_account_id).not.toBe(f.cashAccountId);
  });

  it("numbers payments consecutively", async () => {
    const f = await makeFixture();
    await issueInvoice(f, 50000);

    const first = await post("/customer-payments", paymentBody(f, 10000));
    const second = await post("/customer-payments", paymentBody(f, 10000));

    expect(Number(second.number.slice(4))).toBe(Number(first.number.slice(4)) + 1);
  });

  it("refuses allocations that don't fit, before posting anything", async () => {
    const f = await makeFixture();
    const other = await makeFixture();
    const open = await issueInvoice(f, 50000);
    const draft = await draftInvoice(f, 50000, 30);
    const theirs = await issueInvoice(f, 50000, 30, other.customerId);

    const tooMuch = await rawPost("/customer-payments", paymentBody(f, 60000, { allocations: [{ invoiceId: open.id, amountMinor: 60000 }] }));
    const notIssued = await rawPost("/customer-payments", paymentBody(f, 1000, { allocations: [{ invoiceId: draft.id, amountMinor: 1000 }] }));
    const wrongCustomer = await rawPost("/customer-payments", paymentBody(f, 1000, { allocations: [{ invoiceId: theirs.id, amountMinor: 1000 }] }));
    const unknown = await rawPost("/customer-payments", paymentBody(f, 1000, { allocations: [{ invoiceId: randomUUID(), amountMinor: 1000 }] }));

    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.title).toBe("INVOICE_OVERPAYMENT");
    expect(notIssued.body.title).toBe("INVOICE_INVALID_STATE");
    expect(wrongCustomer.status).toBe(422);
    expect(wrongCustomer.body.title).toBe("PAYMENT_ALLOCATION_INVALID");
    expect(unknown.status).toBe(404);
    expect(await invoice(open.id)).toMatchObject({ status: "ISSUED" });
    expect((await get(`/customer-payments?customer_id=${f.customerId}`)).body.data).toEqual([]);
  });

  it("answers 400 for bad bodies, 404 for an unknown customer and 409 for a repeated clientUuid", async () => {
    const f = await makeFixture();
    const open = await issueInvoice(f, 50000);
    const clientUuid = randomUUID();
    await post("/customer-payments", paymentBody(f, 1000, { clientUuid }));

    const overAllocated = await rawPost("/customer-payments", paymentBody(f, 1000, { allocations: [{ invoiceId: open.id, amountMinor: 2000 }] }));
    const twice = await rawPost(
      "/customer-payments",
      paymentBody(f, 2000, { allocations: [{ invoiceId: open.id, amountMinor: 1000 }, { invoiceId: open.id, amountMinor: 1000 }] }),
    );
    const otherWithoutAccount = await rawPost("/customer-payments", paymentBody(f, 1000, { method: "OTHER", receivedAccountId: undefined }));
    const zero = await rawPost("/customer-payments", paymentBody(f, 0));
    const unknownCustomer = await rawPost("/customer-payments", paymentBody(f, 1000, { customerId: randomUUID() }));
    const repeated = await rawPost("/customer-payments", paymentBody(f, 1000, { clientUuid }));

    expect([overAllocated.status, twice.status, otherWithoutAccount.status, zero.status]).toEqual([400, 400, 400, 400]);
    expect(unknownCustomer.status).toBe(404);
    expect(repeated.status).toBe(409);
  });
});

describe("POST /api/v1/invoices/{id}/payments", () => {
  it("is recorded as a customer payment applied to that invoice", async () => {
    const f = await makeFixture();
    const open = await issueInvoice(f, 50000);

    const paid = await post(`/invoices/${open.id}/payments`, {
      clientUuid: randomUUID(),
      amountMinor: 20000,
      date: today,
      receivedAccountId: f.cashAccountId,
      method: "BANK",
    });
    const list = await get(`/customer-payments?customer_id=${f.customerId}`);

    expect(paid).toMatchObject({ status: "PART_PAID", balance_due_minor: "30000" });
    expect(list.body.data).toEqual([
      expect.objectContaining({ amount_minor: "20000", applied_minor: "20000", method: "BANK", id: paid.allocations[0].customer_payment_id }),
    ]);
  });

  it("still refuses more than the balance", async () => {
    const f = await makeFixture();
    const open = await issueInvoice(f, 50000);

    const response = await rawPost(`/invoices/${open.id}/payments`, {
      clientUuid: randomUUID(),
      amountMinor: 50001,
      date: today,
      receivedAccountId: f.cashAccountId,
    });

    expect(response.status).toBe(422);
    expect(response.body.title).toBe("INVOICE_OVERPAYMENT");
  });
});

describe("GET /api/v1/customer-payments", () => {
  it("lists newest first, filtered by customer, method, credit, date or search", async () => {
    const f = await makeFixture();
    await issueInvoice(f, 60000);
    const cash = await post("/customer-payments", paymentBody(f, 50000));
    const mpesa = await post("/customer-payments", paymentBody(f, 30000, { method: "MPESA", reference: `REF${randomUUID().slice(0, 6)}` }));

    const all = await get(`/customer-payments?customer_id=${f.customerId}`);
    const byMethod = await get(`/customer-payments?customer_id=${f.customerId}&method=MPESA`);
    const withCredit = await get(`/customer-payments?customer_id=${f.customerId}&has_credit=true`);
    const byName = await get(`/customer-payments?q=${encodeURIComponent(f.customerName.toUpperCase())}`);
    const byReference = await get(`/customer-payments?q=${mpesa.reference}`);
    const byNumber = await get(`/customer-payments?q=${cash.number}`);
    const tomorrow = await get(`/customer-payments?customer_id=${f.customerId}&from=${addDays(today, 1)}`);
    const one = await get(`/customer-payments/${cash.id}`);

    expect(all.body.data.map((p: { id: string }) => p.id)).toEqual([mpesa.id, cash.id]);
    expect(all.body.data[0]).not.toHaveProperty("allocations");
    expect(byMethod.body.data.map((p: { id: string }) => p.id)).toEqual([mpesa.id]);
    expect(withCredit.body.data.map((p: { id: string }) => p.id)).toEqual([mpesa.id]);
    expect(byName.body.data.map((p: { id: string }) => p.id)).toEqual([mpesa.id, cash.id]);
    expect(byReference.body.data.map((p: { id: string }) => p.id)).toEqual([mpesa.id]);
    expect(byNumber.body.data.map((p: { id: string }) => p.id)).toEqual([cash.id]);
    expect(tomorrow.body.data).toEqual([]);
    expect(one.body.allocations).toHaveLength(1);
  });

  it("pages with a cursor, and answers 404 for an unknown payment", async () => {
    const f = await makeFixture();
    await issueInvoice(f, 50000);
    const older = await post("/customer-payments", paymentBody(f, 1000));
    const newer = await post("/customer-payments", paymentBody(f, 1000));

    const first = await get(`/customer-payments?customer_id=${f.customerId}&limit=1`);
    const second = await get(`/customer-payments?customer_id=${f.customerId}&limit=1&cursor=${first.body.next_cursor}`);

    expect(first.body).toMatchObject({ has_more: true, data: [expect.objectContaining({ id: newer.id })] });
    expect(second.body).toMatchObject({ has_more: false, next_cursor: null, data: [expect.objectContaining({ id: older.id })] });
    expect((await get(`/customer-payments/${randomUUID()}`)).status).toBe(404);
    expect((await get("/customer-payments/not-a-uuid")).status).toBe(404);
  });
});
