/**
 * Supplier credit: debit notes against no bill, GET /suppliers/{id}/credit,
 * POST /supplier-bills/{id}/apply-credit and /supplier-refunds.
 *
 * Credit comes from a debit note or a supplier payment kept as credit
 * (allocations: [] -- an advance). Everything is dated today.
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
    const result = await client.query<{ account_id: string; debit_minor: string; credit_minor: string; supplier_id: string | null }>(
      `SELECT account_id, debit_minor, credit_minor, supplier_id FROM journal_lines WHERE journal_id = $1 ORDER BY debit_minor DESC`,
      [journalId],
    );
    return result.rows;
  });
}

interface Fixture {
  supplierId: string;
  apAccountId: string;
  expenseAccountId: string;
  bankAccountId: string;
}

async function makeFixture(): Promise<Fixture> {
  const account = async (type: string) =>
    (await post("/accounts", { code: randomUUID().slice(0, 8), name: `Supplier credit ${type}`, type })).id as string;
  return {
    supplierId: (await post("/suppliers", { name: `Credit Supplier ${randomUUID().slice(0, 8)}` })).id,
    apAccountId: await account("LIABILITY"),
    expenseAccountId: await account("EXPENSE"),
    bankAccountId: await account("ASSET"),
  };
}

function line(f: Fixture, amountMinor: number, description = "Stock") {
  return { description, quantity: 1, unitPriceMinor: amountMinor, expenseAccountId: f.expenseAccountId };
}

async function postedBill(f: Fixture, amountMinor: number) {
  return post("/supplier-bills", {
    clientUuid: randomUUID(),
    supplierId: f.supplierId,
    payableAccountId: f.apAccountId,
    billDate: today,
    lines: [line(f, amountMinor)],
    post: true,
  });
}

/** A debit note against no bill, posted. */
async function postedDebitNote(f: Fixture, amountMinor: number, notes = "Returned goods") {
  return post("/supplier-bills", {
    clientUuid: randomUUID(),
    kind: "DEBIT_NOTE",
    supplierId: f.supplierId,
    payableAccountId: f.apAccountId,
    billDate: today,
    supplierReference: `CN-${randomUUID().slice(0, 6)}`,
    notes,
    lines: [line(f, amountMinor, "Damaged cartons returned")],
    post: true,
  });
}

/** A payment kept entirely as credit (an advance). */
async function advance(f: Fixture, amountMinor: number) {
  await postedBill(f, 1); // gives the supplier's credit a payable account
  return post("/supplier-payments", {
    clientUuid: randomUUID(),
    supplierId: f.supplierId,
    amountMinor,
    date: today,
    method: "BANK",
    paidFromAccountId: f.bankAccountId,
    allocations: [],
  });
}

async function balance(f: Fixture) {
  return (await get(`/suppliers/${f.supplierId}`)).body.balance_minor as string;
}

describe("debit notes against no bill", () => {
  it("posts as supplier credit: Dr payables tagged with the supplier, Cr expense", async () => {
    const f = await makeFixture();

    const note = await postedDebitNote(f, 20000);

    expect(note).toMatchObject({
      kind: "DEBIT_NOTE",
      status: "ISSUED",
      number: expect.stringMatching(/^DN-\d{6,}$/),
      debited_bill_id: null,
      due_date: null,
      notes: "Returned goods",
      total_minor: "20000",
      balance_due_minor: "0",
      credit_remaining_minor: "20000",
    });
    expect(await journalLines(note.journal_id)).toEqual([
      { account_id: f.apAccountId, debit_minor: "20000", credit_minor: "0", supplier_id: f.supplierId },
      { account_id: f.expenseAccountId, debit_minor: "0", credit_minor: "20000", supplier_id: null },
    ]);
    expect(await balance(f)).toBe("-20000");
    expect((await get(`/suppliers/${f.supplierId}`)).body.payment_status).toBe("CREDIT");
  });

  it("shows nothing left on a debit note raised against a bill", async () => {
    const f = await makeFixture();
    const bill = await postedBill(f, 50000);
    const draft = await post(`/supplier-bills/${bill.id}/debit-notes`, { clientUuid: randomUUID(), lines: [line(f, 10000)] });

    const posted = await post(`/supplier-bills/${draft.id}/post`);

    expect(posted).toMatchObject({ debited_bill_id: bill.id, amount_paid_minor: "10000", credit_remaining_minor: "0" });
    expect((await get(`/suppliers/${f.supplierId}/credit`)).body.available_minor).toBe("0");
  });

  it("keeps a draft debit note out of the credit, and refuses a due date", async () => {
    const f = await makeFixture();
    const draft = await post("/supplier-bills", {
      clientUuid: randomUUID(),
      kind: "DEBIT_NOTE",
      supplierId: f.supplierId,
      payableAccountId: f.apAccountId,
      billDate: today,
      lines: [line(f, 100)],
    });

    const withDue = await rawPost("/supplier-bills", {
      clientUuid: randomUUID(),
      kind: "DEBIT_NOTE",
      supplierId: f.supplierId,
      billDate: today,
      dueDate: today,
      lines: [line(f, 100)],
    });

    expect(draft).toMatchObject({ kind: "DEBIT_NOTE", status: "DRAFT", credit_remaining_minor: "0" });
    expect((await get(`/suppliers/${f.supplierId}/credit`)).body.available_minor).toBe("0");
    expect(withDue.status).toBe(400);
  });
});

describe("GET /api/v1/suppliers/{id}/credit", () => {
  it("adds up debit notes and advances, oldest first", async () => {
    const f = await makeFixture();
    const note = await postedDebitNote(f, 30000, "Rebate");
    const payment = await advance(f, 20000);

    const credit = await get(`/suppliers/${f.supplierId}/credit`);

    expect(credit.status).toBe(200);
    expect(credit.body).toMatchObject({ supplier_id: f.supplierId, currency: "KES", available_minor: "50000" });
    expect(credit.body.sources).toEqual([
      expect.objectContaining({
        type: "DEBIT_NOTE",
        id: note.id,
        number: note.number,
        remaining_minor: "30000",
        description: "Rebate",
        supplier_reference: note.supplier_reference,
        account_id: f.apAccountId,
      }),
      expect.objectContaining({ type: "PAYMENT", id: payment.id, number: payment.number, remaining_minor: "20000", account_id: f.apAccountId }),
    ]);
  });

  it("is zero for a supplier with none, and 404 for an unknown one", async () => {
    const f = await makeFixture();

    expect((await get(`/suppliers/${f.supplierId}/credit`)).body).toMatchObject({ available_minor: "0", sources: [] });
    expect((await get(`/suppliers/${randomUUID()}/credit`)).status).toBe(404);
  });
});

describe("POST /api/v1/supplier-bills/{id}/apply-credit", () => {
  it("uses the oldest credit first, posting nothing new", async () => {
    const f = await makeFixture();
    const note = await postedDebitNote(f, 30000);
    const payment = await advance(f, 20000);
    const bill = await postedBill(f, 100000);
    const before = await balance(f);
    const ledgerBefore = (await get(`/suppliers/${f.supplierId}/transactions`)).body.data.length;

    const applied = await post(`/supplier-bills/${bill.id}/apply-credit`, { clientUuid: randomUUID() });

    expect(applied).toMatchObject({ status: "PART_PAID", amount_paid_minor: "50000", balance_due_minor: "50000" });
    expect(applied.allocations).toHaveLength(2);
    expect(applied.allocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "DEBIT_NOTE", debit_note_id: note.id, amount_minor: "30000", journal_id: note.journal_id }),
        expect.objectContaining({ method: "BANK", supplier_payment_id: payment.id, amount_minor: "20000", journal_id: payment.journal_id }),
      ]),
    );
    expect(await balance(f)).toBe(before);
    expect((await get(`/suppliers/${f.supplierId}/transactions`)).body.data).toHaveLength(ledgerBefore);
    expect((await get(`/supplier-bills/${note.id}`)).body.credit_remaining_minor).toBe("0");
    expect((await get(`/supplier-payments/${payment.id}`)).body).toMatchObject({ applied_minor: "20000", unapplied_minor: "0" });
    expect((await get(`/suppliers/${f.supplierId}/credit`)).body.available_minor).toBe("0");
  });

  it("applies only what the bill owes, leaving the rest of the credit", async () => {
    const f = await makeFixture();
    const note = await postedDebitNote(f, 30000);
    const bill = await postedBill(f, 10000);

    const applied = await post(`/supplier-bills/${bill.id}/apply-credit`, { clientUuid: randomUUID() });

    expect(applied).toMatchObject({ status: "PAID", balance_due_minor: "0" });
    expect((await get(`/supplier-bills/${note.id}`)).body.credit_remaining_minor).toBe("20000");
  });

  it("uses the credit chosen, and a debit note can pay several bills", async () => {
    const f = await makeFixture();
    const note = await postedDebitNote(f, 30000);
    await advance(f, 20000);
    const first = await postedBill(f, 10000);
    const second = await postedBill(f, 10000);

    await post(`/supplier-bills/${first.id}/apply-credit`, { clientUuid: randomUUID(), sources: [{ debitNoteId: note.id, amountMinor: 5000 }] });
    await post(`/supplier-bills/${second.id}/apply-credit`, {
      clientUuid: randomUUID(),
      amountMinor: 5000,
      sources: [{ debitNoteId: note.id, amountMinor: 5000 }],
    });

    expect((await get(`/supplier-bills/${first.id}`)).body).toMatchObject({ balance_due_minor: "5000" });
    expect((await get(`/supplier-bills/${second.id}`)).body).toMatchObject({ balance_due_minor: "5000" });
    expect((await get(`/supplier-bills/${note.id}`)).body.credit_remaining_minor).toBe("20000");
    expect((await get(`/suppliers/${f.supplierId}/credit`)).body.available_minor).toBe("40000");
  });

  it("refuses what doesn't fit, changing nothing", async () => {
    const f = await makeFixture();
    const other = await makeFixture();
    const note = await postedDebitNote(f, 30000);
    const bill = await postedBill(f, 50000);
    const draft = await post("/supplier-bills", {
      clientUuid: randomUUID(),
      supplierId: f.supplierId,
      payableAccountId: f.apAccountId,
      billDate: today,
      lines: [line(f, 1000)],
    });
    const theirNote = await postedDebitNote(other, 5000);
    const clientUuid = randomUUID();
    await post(`/supplier-bills/${bill.id}/apply-credit`, { clientUuid, amountMinor: 1000 });

    const tooMuch = await rawPost(`/supplier-bills/${bill.id}/apply-credit`, { clientUuid: randomUUID(), amountMinor: 49001 });
    const notEnough = await rawPost(`/supplier-bills/${bill.id}/apply-credit`, {
      clientUuid: randomUUID(),
      sources: [{ debitNoteId: note.id, amountMinor: 29001 }],
    });
    const notTheirs = await rawPost(`/supplier-bills/${bill.id}/apply-credit`, {
      clientUuid: randomUUID(),
      sources: [{ debitNoteId: theirNote.id, amountMinor: 100 }],
    });
    const onDraft = await rawPost(`/supplier-bills/${draft.id}/apply-credit`, { clientUuid: randomUUID() });
    const onNote = await rawPost(`/supplier-bills/${note.id}/apply-credit`, { clientUuid: randomUUID() });
    const mismatch = await rawPost(`/supplier-bills/${bill.id}/apply-credit`, {
      clientUuid: randomUUID(),
      amountMinor: 200,
      sources: [{ debitNoteId: note.id, amountMinor: 100 }],
    });
    const early = await rawPost(`/supplier-bills/${bill.id}/apply-credit`, { clientUuid: randomUUID(), date: "2020-01-01" });
    const repeated = await rawPost(`/supplier-bills/${bill.id}/apply-credit`, { clientUuid, amountMinor: 1000 });

    expect([tooMuch.status, tooMuch.body.title]).toEqual([422, "INVOICE_OVERPAYMENT"]);
    expect([notEnough.status, notEnough.body.title]).toEqual([422, "CREDIT_NOT_AVAILABLE"]);
    expect(notTheirs.body.title).toBe("CREDIT_NOT_AVAILABLE");
    expect(onDraft.body.title).toBe("INVOICE_INVALID_STATE");
    expect(onNote.body.title).toBe("INVOICE_INVALID_STATE");
    expect(mismatch.status).toBe(400);
    expect(early.status).toBe(400);
    expect(repeated.status).toBe(409);
    expect((await get(`/supplier-bills/${bill.id}`)).body.balance_due_minor).toBe("49000");
    expect((await get(`/supplier-bills/${note.id}`)).body.credit_remaining_minor).toBe("29000");
  });

  it("refuses credit sitting in a different payable account", async () => {
    const f = await makeFixture();
    const note = await postedDebitNote(f, 5000);
    const otherAp = (await post("/accounts", { code: randomUUID().slice(0, 8), name: "Other AP", type: "LIABILITY" })).id;
    const bill = await post("/supplier-bills", {
      clientUuid: randomUUID(),
      supplierId: f.supplierId,
      payableAccountId: otherAp,
      billDate: today,
      lines: [line(f, 5000)],
      post: true,
    });

    const response = await rawPost(`/supplier-bills/${bill.id}/apply-credit`, {
      clientUuid: randomUUID(),
      sources: [{ debitNoteId: note.id, amountMinor: 5000 }],
    });

    expect([response.status, response.body.title]).toEqual([422, "PAYMENT_ALLOCATION_INVALID"]);
  });

  it("answers 422 when the supplier has no credit", async () => {
    const f = await makeFixture();
    const bill = await postedBill(f, 10000);

    const response = await rawPost(`/supplier-bills/${bill.id}/apply-credit`, { clientUuid: randomUUID() });

    expect([response.status, response.body.title]).toEqual([422, "CREDIT_NOT_AVAILABLE"]);
  });
});

describe("POST /api/v1/supplier-refunds", () => {
  it("records credit paid back: Dr the money account, Cr payables tagged with the supplier", async () => {
    const f = await makeFixture();
    const payment = await advance(f, 20000);
    const before = Number(await balance(f));

    const refund = await post("/supplier-refunds", {
      clientUuid: randomUUID(),
      supplierId: f.supplierId,
      amountMinor: 15000,
      date: today,
      method: "BANK",
      receivedAccountId: f.bankAccountId,
      reference: "EFT 99120",
      memo: "Advance returned",
    });

    expect(refund).toMatchObject({
      number: expect.stringMatching(/^SRF-\d{6}$/),
      supplier_id: f.supplierId,
      amount_minor: "15000",
      method: "BANK",
      received_account_id: f.bankAccountId,
      reference: "EFT 99120",
      memo: "Advance returned",
      sources: [{ type: "PAYMENT", id: payment.id, number: payment.number, amount_minor: "15000" }],
    });
    expect(await journalLines(refund.journal_id)).toEqual([
      { account_id: f.bankAccountId, debit_minor: "15000", credit_minor: "0", supplier_id: null },
      { account_id: f.apAccountId, debit_minor: "0", credit_minor: "15000", supplier_id: f.supplierId },
    ]);
    expect(Number(await balance(f))).toBe(before + 15000);
    expect((await get(`/supplier-payments/${payment.id}`)).body).toMatchObject({
      applied_minor: "0",
      unapplied_minor: "5000",
      refunded_minor: "15000",
    });

    const ledger = (await get(`/suppliers/${f.supplierId}/transactions`)).body.data;
    expect(ledger.at(-1)).toMatchObject({
      type: "REFUND",
      document_kind: "SUPPLIER_REFUND",
      document_id: refund.id,
      document_number: refund.number,
      payment_method: "BANK",
      reference: "EFT 99120",
      credit_minor: "15000",
    });
    expect((await get(`/suppliers/${f.supplierId}`)).body.last_activity).toMatchObject({ type: "REFUND", document_number: refund.number });
  });

  it("refunds a debit note's credit", async () => {
    const f = await makeFixture();
    const note = await postedDebitNote(f, 8000);

    const refund = await post("/supplier-refunds", {
      clientUuid: randomUUID(),
      supplierId: f.supplierId,
      amountMinor: 8000,
      date: today,
      method: "CHEQUE",
      receivedAccountId: f.bankAccountId,
      reference: "000452",
    });

    expect(refund).toMatchObject({ method: "CHEQUE", reference: "000452" });
    expect(refund.sources).toEqual([{ type: "DEBIT_NOTE", id: note.id, number: note.number, amount_minor: "8000" }]);
    expect((await get(`/supplier-bills/${note.id}`)).body.credit_remaining_minor).toBe("0");
    expect(await balance(f)).toBe("0");
  });

  it("banks a cheque by default", async () => {
    const f = await makeFixture();
    await postedDebitNote(f, 500);

    const response = await rawPost("/supplier-refunds", {
      clientUuid: randomUUID(),
      supplierId: f.supplierId,
      amountMinor: 500,
      date: today,
      method: "CHEQUE",
    });
    const tenant = (await get("/tenant")).body;

    if (tenant.system_accounts.BANK) {
      expect(response.status).toBe(201);
      expect(response.body.received_account_id).toBe(tenant.system_accounts.BANK);
    } else {
      expect([response.status, response.body.title]).toEqual([422, "SYSTEM_ACCOUNT_MISSING"]);
      expect(response.body.errors[0].path).toBe("receivedAccountId");
    }
  });

  it("refuses more than the credit, and OTHER without an account", async () => {
    const f = await makeFixture();
    await postedDebitNote(f, 1000);

    const tooMuch = await rawPost("/supplier-refunds", {
      clientUuid: randomUUID(),
      supplierId: f.supplierId,
      amountMinor: 1001,
      date: today,
    });
    const other = await rawPost("/supplier-refunds", {
      clientUuid: randomUUID(),
      supplierId: f.supplierId,
      amountMinor: 100,
      date: today,
      method: "OTHER",
    });

    expect([tooMuch.status, tooMuch.body.title]).toEqual([422, "CREDIT_NOT_AVAILABLE"]);
    expect(other.status).toBe(400);
    expect((await get(`/suppliers/${f.supplierId}/credit`)).body.available_minor).toBe("1000");
  });

  it("lists a supplier's refunds and answers 404 for an unknown one", async () => {
    const f = await makeFixture();
    await postedDebitNote(f, 3000);
    const first = await post("/supplier-refunds", { clientUuid: randomUUID(), supplierId: f.supplierId, amountMinor: 1000, date: today });
    const second = await post("/supplier-refunds", { clientUuid: randomUUID(), supplierId: f.supplierId, amountMinor: 2000, date: today });

    const list = await get(`/supplier-refunds?supplier_id=${f.supplierId}`);

    expect(list.status).toBe(200);
    expect(list.body.data.map((r: { id: string }) => r.id)).toEqual([second.id, first.id]);
    expect(list.body.data[0]).not.toHaveProperty("sources");
    expect((await get(`/supplier-refunds/${second.id}`)).body.sources).toHaveLength(1);
    expect((await get(`/supplier-refunds/${randomUUID()}`)).status).toBe(404);
  });
});
