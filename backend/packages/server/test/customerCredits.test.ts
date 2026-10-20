/**
 * Customer credit: credit notes against no invoice, GET /customers/{id}/credit,
 * POST /invoices/{id}/apply-credit and /customer-refunds.
 *
 * Credit comes from a credit note or a payment kept as credit
 * (allocations: []). Everything is dated today.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@jibuks/db";
import { SYSTEM_ROLES } from "@jibuks/domain";
import { createApp } from "../src/app.js";
import { describeTransaction } from "../src/modules/customerStatements/pdf.js";
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
  arAccountId: string;
  salesAccountId: string;
  cashAccountId: string;
}

async function makeFixture(): Promise<Fixture> {
  const account = async (type: string) =>
    (await post("/accounts", { code: randomUUID().slice(0, 8), name: `Credit ${type}`, type })).id as string;
  return {
    customerId: (await post("/customers", { name: `Credit Customer ${randomUUID().slice(0, 8)}` })).id,
    arAccountId: await account("ASSET"),
    salesAccountId: await account("INCOME"),
    cashAccountId: await account("ASSET"),
  };
}

function line(f: Fixture, amountMinor: number, description = "Goods") {
  return { description, quantity: 1, unitPriceMinor: amountMinor, incomeAccountId: f.salesAccountId };
}

async function issueInvoice(f: Fixture, amountMinor: number) {
  return post("/invoices", {
    clientUuid: randomUUID(),
    customerId: f.customerId,
    receivableAccountId: f.arAccountId,
    issueDate: today,
    lines: [line(f, amountMinor)],
    issue: true,
  });
}

/** A credit note against no invoice, issued. */
async function issueCreditNote(f: Fixture, amountMinor: number, notes = "Discount") {
  return post("/invoices", {
    clientUuid: randomUUID(),
    kind: "CREDIT_NOTE",
    customerId: f.customerId,
    receivableAccountId: f.arAccountId,
    issueDate: today,
    notes,
    lines: [line(f, amountMinor, "Loyalty discount")],
    issue: true,
  });
}

/** A payment kept entirely as credit. */
async function creditPayment(f: Fixture, amountMinor: number) {
  await issueInvoice(f, 1); // gives the customer's credit a receivable account
  const payment = await post("/customer-payments", {
    clientUuid: randomUUID(),
    customerId: f.customerId,
    amountMinor,
    date: today,
    receivedAccountId: f.cashAccountId,
    allocations: [],
  });
  return payment;
}

async function balance(f: Fixture) {
  return (await get(`/customers/${f.customerId}`)).body.balance_minor as string;
}

describe("credit notes against no invoice", () => {
  it("issues as customer credit: Dr income, Cr receivables tagged with the customer", async () => {
    const f = await makeFixture();

    const note = await issueCreditNote(f, 20000);

    expect(note).toMatchObject({
      kind: "CREDIT_NOTE",
      status: "ISSUED",
      number: expect.stringMatching(/^CN-\d{6,}$/),
      credited_invoice_id: null,
      due_date: null,
      payment_terms_days: null,
      notes: "Discount",
      total_minor: "20000",
      credit_remaining_minor: "20000",
    });
    expect(await journalLines(note.journal_id)).toEqual([
      { account_id: f.salesAccountId, debit_minor: "20000", credit_minor: "0", customer_id: null },
      { account_id: f.arAccountId, debit_minor: "0", credit_minor: "20000", customer_id: f.customerId },
    ]);
    expect(await balance(f)).toBe("-20000");
  });

  it("shows nothing left on a credit note raised against an invoice", async () => {
    const f = await makeFixture();
    const invoice = await issueInvoice(f, 50000);
    const draft = await post(`/invoices/${invoice.id}/credit-notes`, { clientUuid: randomUUID(), lines: [line(f, 10000)] });

    const issued = await post(`/invoices/${draft.id}/issue`);

    expect(issued).toMatchObject({ credited_invoice_id: invoice.id, credit_remaining_minor: "0" });
  });

  it("refuses due dates and terms on a credit note", async () => {
    const f = await makeFixture();

    const response = await rawPost("/invoices", {
      clientUuid: randomUUID(),
      kind: "CREDIT_NOTE",
      customerId: f.customerId,
      issueDate: today,
      dueDate: today,
      lines: [line(f, 100)],
    });

    expect(response.status).toBe(400);
  });
});

describe("GET /api/v1/customers/{id}/credit", () => {
  it("adds up credit notes and payments with credit, oldest first", async () => {
    const f = await makeFixture();
    const note = await issueCreditNote(f, 30000, "Returned goods");
    const payment = await creditPayment(f, 20000);

    const credit = await get(`/customers/${f.customerId}/credit`);

    expect(credit.status).toBe(200);
    expect(credit.body).toMatchObject({ customer_id: f.customerId, currency: "KES", available_minor: "50000" });
    expect(credit.body.sources).toEqual([
      expect.objectContaining({ type: "CREDIT_NOTE", id: note.id, number: note.number, remaining_minor: "30000", description: "Returned goods" }),
      expect.objectContaining({ type: "PAYMENT", id: payment.id, number: payment.number, remaining_minor: "20000", account_id: f.arAccountId }),
    ]);
  });

  it("is zero for a customer with none, and 404 for an unknown one", async () => {
    const f = await makeFixture();

    expect((await get(`/customers/${f.customerId}/credit`)).body).toMatchObject({ available_minor: "0", sources: [] });
    expect((await get(`/customers/${randomUUID()}/credit`)).status).toBe(404);
  });
});

describe("POST /api/v1/invoices/{id}/apply-credit", () => {
  it("uses the oldest credit first, posting nothing new", async () => {
    const f = await makeFixture();
    const note = await issueCreditNote(f, 30000);
    const payment = await creditPayment(f, 20000);
    const invoice = await issueInvoice(f, 100000);
    const before = await balance(f);
    const ledgerBefore = (await get(`/customers/${f.customerId}/transactions`)).body.data.length;

    const applied = await post(`/invoices/${invoice.id}/apply-credit`, { clientUuid: randomUUID() });

    expect(applied).toMatchObject({ status: "PART_PAID", amount_paid_minor: "50000", balance_due_minor: "50000" });
    // Both made in one transaction, so in no particular order.
    expect(applied.allocations).toHaveLength(2);
    expect(applied.allocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "CREDIT_NOTE", credit_note_id: note.id, amount_minor: "30000", journal_id: note.journal_id }),
        expect.objectContaining({ method: "CASH", customer_payment_id: payment.id, amount_minor: "20000", journal_id: payment.journal_id }),
      ]),
    );
    expect(await balance(f)).toBe(before);
    expect((await get(`/customers/${f.customerId}/transactions`)).body.data).toHaveLength(ledgerBefore);
    expect((await get(`/invoices/${note.id}`)).body.credit_remaining_minor).toBe("0");
    expect((await get(`/customer-payments/${payment.id}`)).body).toMatchObject({ applied_minor: "20000", unapplied_minor: "0" });
    expect((await get(`/customers/${f.customerId}/credit`)).body.available_minor).toBe("0");
  });

  it("applies only what the invoice owes, leaving the rest of the credit", async () => {
    const f = await makeFixture();
    const note = await issueCreditNote(f, 30000);
    const invoice = await issueInvoice(f, 10000);

    const applied = await post(`/invoices/${invoice.id}/apply-credit`, { clientUuid: randomUUID() });

    expect(applied).toMatchObject({ status: "PAID", balance_due_minor: "0" });
    expect((await get(`/invoices/${note.id}`)).body.credit_remaining_minor).toBe("20000");
  });

  it("uses the credit chosen, and a credit note can pay several invoices", async () => {
    const f = await makeFixture();
    const note = await issueCreditNote(f, 30000);
    await creditPayment(f, 20000);
    const first = await issueInvoice(f, 10000);
    const second = await issueInvoice(f, 10000);

    await post(`/invoices/${first.id}/apply-credit`, { clientUuid: randomUUID(), sources: [{ creditNoteId: note.id, amountMinor: 5000 }] });
    await post(`/invoices/${second.id}/apply-credit`, { clientUuid: randomUUID(), amountMinor: 5000, sources: [{ creditNoteId: note.id, amountMinor: 5000 }] });

    expect((await get(`/invoices/${first.id}`)).body).toMatchObject({ balance_due_minor: "5000" });
    expect((await get(`/invoices/${second.id}`)).body).toMatchObject({ balance_due_minor: "5000" });
    expect((await get(`/invoices/${note.id}`)).body.credit_remaining_minor).toBe("20000");
    expect((await get(`/customers/${f.customerId}/credit`)).body.available_minor).toBe("40000");
  });

  it("refuses what doesn't fit, changing nothing", async () => {
    const f = await makeFixture();
    const other = await makeFixture();
    const note = await issueCreditNote(f, 30000);
    const invoice = await issueInvoice(f, 50000);
    const draft = await post("/invoices", {
      clientUuid: randomUUID(),
      customerId: f.customerId,
      receivableAccountId: f.arAccountId,
      issueDate: today,
      lines: [line(f, 1000)],
    });
    const theirNote = await issueCreditNote(other, 5000);
    const clientUuid = randomUUID();
    await post(`/invoices/${invoice.id}/apply-credit`, { clientUuid, amountMinor: 1000 });

    const tooMuch = await rawPost(`/invoices/${invoice.id}/apply-credit`, { clientUuid: randomUUID(), amountMinor: 49001 });
    const notEnough = await rawPost(`/invoices/${invoice.id}/apply-credit`, {
      clientUuid: randomUUID(),
      sources: [{ creditNoteId: note.id, amountMinor: 29001 }],
    });
    const notTheirs = await rawPost(`/invoices/${invoice.id}/apply-credit`, {
      clientUuid: randomUUID(),
      sources: [{ creditNoteId: theirNote.id, amountMinor: 100 }],
    });
    const onDraft = await rawPost(`/invoices/${draft.id}/apply-credit`, { clientUuid: randomUUID() });
    const mismatch = await rawPost(`/invoices/${invoice.id}/apply-credit`, {
      clientUuid: randomUUID(),
      amountMinor: 200,
      sources: [{ creditNoteId: note.id, amountMinor: 100 }],
    });
    const early = await rawPost(`/invoices/${invoice.id}/apply-credit`, { clientUuid: randomUUID(), date: "2020-01-01" });
    const repeated = await rawPost(`/invoices/${invoice.id}/apply-credit`, { clientUuid, amountMinor: 1000 });

    expect([tooMuch.status, tooMuch.body.title]).toEqual([422, "INVOICE_OVERPAYMENT"]);
    expect([notEnough.status, notEnough.body.title]).toEqual([422, "CREDIT_NOT_AVAILABLE"]);
    expect(notTheirs.body.title).toBe("CREDIT_NOT_AVAILABLE");
    expect(onDraft.body.title).toBe("INVOICE_INVALID_STATE");
    expect(mismatch.status).toBe(400);
    expect(early.status).toBe(400);
    expect(repeated.status).toBe(409);
    expect((await get(`/invoices/${invoice.id}`)).body.balance_due_minor).toBe("49000");
    expect((await get(`/invoices/${note.id}`)).body.credit_remaining_minor).toBe("29000");
  });

  it("answers 422 when the customer has no credit", async () => {
    const f = await makeFixture();
    const invoice = await issueInvoice(f, 10000);

    const response = await rawPost(`/invoices/${invoice.id}/apply-credit`, { clientUuid: randomUUID() });

    expect([response.status, response.body.title]).toEqual([422, "CREDIT_NOT_AVAILABLE"]);
  });
});

describe("POST /api/v1/customer-refunds", () => {
  it("pays credit back: Dr receivables tagged with the customer, Cr the money account", async () => {
    const f = await makeFixture();
    const payment = await creditPayment(f, 50000);
    const before = await balance(f);

    const refund = await post("/customer-refunds", {
      clientUuid: randomUUID(),
      customerId: f.customerId,
      amountMinor: 30000,
      date: today,
      method: "CASH",
      paidFromAccountId: f.cashAccountId,
      reference: "Counter refund",
    });

    expect(refund).toMatchObject({
      number: expect.stringMatching(/^RF-\d{6,}$/),
      customer_id: f.customerId,
      amount_minor: "30000",
      method: "CASH",
      paid_from_account_id: f.cashAccountId,
      reference: "Counter refund",
      sources: [{ type: "PAYMENT", id: payment.id, number: payment.number, amount_minor: "30000" }],
    });
    expect(await journalLines(refund.journal_id)).toEqual([
      { account_id: f.arAccountId, debit_minor: "30000", credit_minor: "0", customer_id: f.customerId },
      { account_id: f.cashAccountId, debit_minor: "0", credit_minor: "30000", customer_id: null },
    ]);
    expect(Number(await balance(f))).toBe(Number(before) + 30000);
    expect((await get(`/customer-payments/${payment.id}`)).body).toMatchObject({ unapplied_minor: "20000", refunded_minor: "30000" });
    const ledger = (await get(`/customers/${f.customerId}/transactions`)).body.data;
    expect(ledger.at(-1)).toMatchObject({ type: "REFUND", document_kind: "CUSTOMER_REFUND", document_number: refund.number, debit_minor: "30000" });
  });

  it("refunds a credit note's credit", async () => {
    const f = await makeFixture();
    const note = await issueCreditNote(f, 20000);

    const refund = await post("/customer-refunds", {
      clientUuid: randomUUID(),
      customerId: f.customerId,
      amountMinor: 20000,
      date: today,
      paidFromAccountId: f.cashAccountId,
      sources: [{ creditNoteId: note.id, amountMinor: 20000 }],
    });

    expect(refund.sources).toEqual([{ type: "CREDIT_NOTE", id: note.id, number: note.number, amount_minor: "20000" }]);
    expect((await get(`/invoices/${note.id}`)).body.credit_remaining_minor).toBe("0");
    expect(await balance(f)).toBe("0");
  });

  it("refuses more than the credit, and OTHER without an account", async () => {
    const f = await makeFixture();
    await creditPayment(f, 10000);

    const tooMuch = await rawPost("/customer-refunds", {
      clientUuid: randomUUID(),
      customerId: f.customerId,
      amountMinor: 10001,
      date: today,
      paidFromAccountId: f.cashAccountId,
    });
    const other = await rawPost("/customer-refunds", {
      clientUuid: randomUUID(),
      customerId: f.customerId,
      amountMinor: 100,
      date: today,
      method: "OTHER",
    });

    expect([tooMuch.status, tooMuch.body.title]).toEqual([422, "CREDIT_NOT_AVAILABLE"]);
    expect(other.status).toBe(400);
    expect((await get(`/customers/${f.customerId}/credit`)).body.available_minor).toBe("10000");
  });

  it("lists a customer's refunds and answers 404 for an unknown one", async () => {
    const f = await makeFixture();
    await creditPayment(f, 10000);
    const refund = await post("/customer-refunds", {
      clientUuid: randomUUID(),
      customerId: f.customerId,
      amountMinor: 4000,
      date: today,
      paidFromAccountId: f.cashAccountId,
    });

    const list = await get(`/customer-refunds?customer_id=${f.customerId}`);

    expect(list.body).toMatchObject({ has_more: false, data: [expect.objectContaining({ id: refund.id, amount_minor: "4000" })] });
    expect(list.body.data[0]).not.toHaveProperty("sources");
    expect((await get(`/customer-refunds/${randomUUID()}`)).status).toBe(404);
  });

  it("is for Owners and Accountants only", () => {
    expect(SYSTEM_ROLES.ACCOUNTANT.permissions).toContain("refunds:create");
    expect(SYSTEM_ROLES.CASHIER.permissions).not.toContain("refunds:create");
    expect(SYSTEM_ROLES.VIEWER.permissions).not.toContain("refunds:create");
  });

  it("reads as a refund on a statement", () => {
    expect(
      describeTransaction({
        journal_id: randomUUID(),
        journal_number: null,
        date: today,
        type: "REFUND",
        document_id: randomUUID(),
        document_kind: "CUSTOMER_REFUND",
        document_number: "RF-000002",
        credited_invoice_id: null,
        credited_invoice_number: null,
        payment_method: "MPESA",
        reference: "QAB12CD34E",
        description: "",
        applied_invoices: [],
        unapplied_minor: null,
        debit_minor: "100",
        credit_minor: "0",
        balance_minor: "0",
      }),
    ).toBe("Refund RF-000002 (M-Pesa QAB12CD34E)");
  });
});
