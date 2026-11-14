/**
 * Supplier payments (Pay Bills): POST/GET /supplier-payments --
 * oldest-due-first application, chosen bills, money beyond what's owed
 * kept as supplier credit, the one journal each payment posts, cheques,
 * and the list filters. Also POST /supplier-bills/{id}/payments, which is
 * now recorded as a supplier payment.
 *
 * Bills are posted today with different due dates, so "oldest due first"
 * is decided by due date alone.
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
  await withTenant(TEST_TENANT_ID, async (client) => {
    await client.query(`UPDATE tenants SET vat_registered = true WHERE id = $1`, [TEST_TENANT_ID]);
  });
});

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
    const result = await client.query<{ account_id: string; debit_minor: string; credit_minor: string; supplier_id: string | null }>(
      `SELECT account_id, debit_minor, credit_minor, supplier_id FROM journal_lines WHERE journal_id = $1 ORDER BY credit_minor, account_id`,
      [journalId],
    );
    return result.rows;
  });
}

interface Fixture {
  supplierId: string;
  supplierName: string;
  apAccountId: string;
  otherApAccountId: string;
  expenseAccountId: string;
  bankAccountId: string;
}

async function makeFixture(): Promise<Fixture> {
  const account = async (type: string) =>
    (await post("/accounts", { code: randomUUID().slice(0, 8), name: `Supplier payments ${type}`, type })).id as string;
  const supplierName = `Pay Supplier ${randomUUID().slice(0, 8)}`;
  return {
    supplierId: (await post("/suppliers", { name: supplierName })).id,
    supplierName,
    apAccountId: await account("LIABILITY"),
    otherApAccountId: await account("LIABILITY"),
    expenseAccountId: await account("EXPENSE"),
    bankAccountId: await account("ASSET"),
  };
}

async function draftBill(f: Fixture, amountMinor: number, dueInDays: number, overrides: Record<string, unknown> = {}) {
  return post("/supplier-bills", {
    clientUuid: randomUUID(),
    supplierId: f.supplierId,
    payableAccountId: f.apAccountId,
    billDate: today,
    dueDate: addDays(today, dueInDays),
    lines: [{ description: "Stock", quantity: 1, unitPriceMinor: amountMinor, expenseAccountId: f.expenseAccountId }],
    ...overrides,
  });
}

async function postedBill(f: Fixture, amountMinor: number, dueInDays = 30, overrides: Record<string, unknown> = {}) {
  const draft = await draftBill(f, amountMinor, dueInDays, overrides);
  return post(`/supplier-bills/${draft.id}/post`);
}

async function bill(id: string) {
  return (await get(`/supplier-bills/${id}`)).body;
}

function paymentBody(f: Fixture, amountMinor: number, overrides: Record<string, unknown> = {}) {
  return {
    clientUuid: randomUUID(),
    supplierId: f.supplierId,
    amountMinor,
    date: today,
    method: "BANK",
    paidFromAccountId: f.bankAccountId,
    ...overrides,
  };
}

describe("POST /api/v1/supplier-payments", () => {
  it("pays the open bills oldest due first when none are chosen", async () => {
    const f = await makeFixture();
    const later = await postedBill(f, 30000, 30);
    const sooner = await postedBill(f, 20000, 5);
    const third = await postedBill(f, 40000, 60);

    const payment = await post("/supplier-payments", paymentBody(f, 35000, { reference: "EFT 7781" }));

    expect(payment).toMatchObject({
      supplier_id: f.supplierId,
      supplier_name: f.supplierName,
      amount_minor: "35000",
      applied_minor: "35000",
      unapplied_minor: "0",
      method: "BANK",
      paid_from_account_id: f.bankAccountId,
      reference: "EFT 7781",
    });
    expect(payment.number).toMatch(/^SP-\d{6,}$/);
    expect(payment.allocations).toEqual([
      expect.objectContaining({ bill_id: sooner.id, bill_number: sooner.number, amount_minor: "20000" }),
      expect.objectContaining({ bill_id: later.id, bill_number: later.number, amount_minor: "15000" }),
    ]);
    expect(await bill(sooner.id)).toMatchObject({ status: "PAID", balance_due_minor: "0" });
    expect(await bill(later.id)).toMatchObject({ status: "PART_PAID", balance_due_minor: "15000" });
    expect(await bill(third.id)).toMatchObject({ status: "ISSUED" });
    expect((await bill(later.id)).allocations[0]).toMatchObject({ supplier_payment_id: payment.id, method: "BANK" });
  });

  it("posts one journal: Dr payables by each bill's account (tagged), Dr credit, Cr the money account", async () => {
    const f = await makeFixture();
    await postedBill(f, 20000, 5);
    await postedBill(f, 10000, 10, { payableAccountId: f.otherApAccountId });

    const payment = await post("/supplier-payments", paymentBody(f, 40000));

    expect(payment).toMatchObject({ applied_minor: "30000", unapplied_minor: "10000", credit_account_id: f.apAccountId });
    expect(await journalLines(payment.journal_id)).toEqual(
      expect.arrayContaining([
        { account_id: f.apAccountId, debit_minor: "30000", credit_minor: "0", supplier_id: f.supplierId },
        { account_id: f.otherApAccountId, debit_minor: "10000", credit_minor: "0", supplier_id: f.supplierId },
        { account_id: f.bankAccountId, debit_minor: "0", credit_minor: "40000", supplier_id: null },
      ]),
    );
    expect((await journalLines(payment.journal_id)).length).toBe(3);
  });

  it("keeps money beyond what's owed as supplier credit: the supplier then owes the business", async () => {
    const f = await makeFixture();
    await postedBill(f, 20000, 5);

    const payment = await post("/supplier-payments", paymentBody(f, 25000));
    const supplier = (await get(`/suppliers/${f.supplierId}`)).body;

    expect(payment).toMatchObject({ applied_minor: "20000", unapplied_minor: "5000" });
    expect(supplier).toMatchObject({ balance_minor: "-5000", payment_status: "CREDIT" });
  });

  it("pays only the chosen bills, and keeps the rest as credit", async () => {
    const f = await makeFixture();
    const sooner = await postedBill(f, 20000, 5);
    const later = await postedBill(f, 30000, 30);

    const payment = await post("/supplier-payments", paymentBody(f, 35000, { allocations: [{ billId: later.id, amountMinor: 30000 }] }));

    expect(payment).toMatchObject({ applied_minor: "30000", unapplied_minor: "5000" });
    expect(payment.allocations).toEqual([expect.objectContaining({ bill_id: later.id, amount_minor: "30000" })]);
    expect(await bill(sooner.id)).toMatchObject({ status: "ISSUED" });
  });

  it("keeps it all as credit (an advance) with allocations: [], or when nothing is owed", async () => {
    const f = await makeFixture();
    const open = await postedBill(f, 20000, 5);
    const nothingOwed = await makeFixture();

    const advance = await post("/supplier-payments", paymentBody(f, 10000, { allocations: [] }));
    const toNewSupplier = await rawPost("/supplier-payments", paymentBody(nothingOwed, 10000, { paidFromAccountId: f.bankAccountId }));
    const tenant = (await get("/tenant")).body;

    // Credit sits in the payable account of the supplier's open bills ...
    expect(advance).toMatchObject({ applied_minor: "0", unapplied_minor: "10000", credit_account_id: f.apAccountId, allocations: [] });
    expect(await bill(open.id)).toMatchObject({ status: "ISSUED" });
    // ... and with none, in the business's PAYABLE account (which the shared test business may not have).
    if (tenant.system_accounts.PAYABLE) {
      expect(toNewSupplier.body).toMatchObject({ unapplied_minor: "10000", credit_account_id: tenant.system_accounts.PAYABLE });
    } else {
      expect(toNewSupplier.status).toBe(422);
      expect(toNewSupplier.body.title).toBe("SYSTEM_ACCOUNT_MISSING");
    }
  });

  it("pays by cheque: method CHEQUE with the cheque number, from the Bank account by default", async () => {
    const f = await makeFixture();
    const open = await postedBill(f, 20000, 5);

    const named = await post("/supplier-payments", paymentBody(f, 5000, { method: "CHEQUE", reference: "004512" }));
    const byDefault = await rawPost("/supplier-payments", paymentBody(f, 5000, { method: "CHEQUE", paidFromAccountId: undefined }));
    const tenant = (await get("/tenant")).body;

    expect(named).toMatchObject({ method: "CHEQUE", reference: "004512" });
    expect((await bill(open.id)).allocations[0]).toMatchObject({ method: "CHEQUE", reference: "004512" });
    if (tenant.system_accounts.BANK) {
      expect(byDefault.status).toBe(201);
      expect(byDefault.body.paid_from_account_id).toBe(tenant.system_accounts.BANK);
    } else {
      expect(byDefault.status).toBe(422);
      expect(byDefault.body.title).toBe("SYSTEM_ACCOUNT_MISSING");
    }
  });

  it("numbers payments SP- without gaps", async () => {
    const f = await makeFixture();
    await postedBill(f, 10000);
    const first = await post("/supplier-payments", paymentBody(f, 1000));
    const second = await post("/supplier-payments", paymentBody(f, 1000));

    // Other test files post payments on this business at the same time, so
    // the two needn't be adjacent: check order, and that no number is skipped.
    const counts = await withTenant(TEST_TENANT_ID, async (client) => {
      const result = await client.query<{ issued: number; stored: number }>(
        `SELECT (SELECT last_value FROM supplier_payment_number_sequences)::int AS issued,
                (SELECT count(*) FROM supplier_payments)::int AS stored`,
      );
      return result.rows[0]!;
    });
    expect(Number(second.number.slice(3))).toBeGreaterThan(Number(first.number.slice(3)));
    expect(counts.issued).toBe(counts.stored);
  });

  it("refuses allocations that don't fit, before posting anything", async () => {
    const f = await makeFixture();
    const other = await makeFixture();
    const open = await postedBill(f, 50000);
    const draft = await draftBill(f, 50000, 30);
    const theirs = await postedBill(other, 50000);

    const tooMuch = await rawPost("/supplier-payments", paymentBody(f, 60000, { allocations: [{ billId: open.id, amountMinor: 60000 }] }));
    const notPosted = await rawPost("/supplier-payments", paymentBody(f, 1000, { allocations: [{ billId: draft.id, amountMinor: 1000 }] }));
    const wrongSupplier = await rawPost("/supplier-payments", paymentBody(f, 1000, { allocations: [{ billId: theirs.id, amountMinor: 1000 }] }));
    const unknown = await rawPost("/supplier-payments", paymentBody(f, 1000, { allocations: [{ billId: randomUUID(), amountMinor: 1000 }] }));

    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.title).toBe("INVOICE_OVERPAYMENT");
    expect(notPosted.body.title).toBe("INVOICE_INVALID_STATE");
    expect(wrongSupplier.status).toBe(422);
    expect(wrongSupplier.body.title).toBe("PAYMENT_ALLOCATION_INVALID");
    expect(unknown.status).toBe(404);
    expect(await bill(open.id)).toMatchObject({ status: "ISSUED" });
    expect((await get(`/supplier-payments?supplier_id=${f.supplierId}`)).body.data).toEqual([]);
  });

  it("answers 400 for bad bodies, 404 for an unknown supplier and 409 for a repeated clientUuid", async () => {
    const f = await makeFixture();
    const open = await postedBill(f, 50000);
    const clientUuid = randomUUID();
    await post("/supplier-payments", paymentBody(f, 1000, { clientUuid }));

    const overAllocated = await rawPost("/supplier-payments", paymentBody(f, 1000, { allocations: [{ billId: open.id, amountMinor: 2000 }] }));
    const twice = await rawPost(
      "/supplier-payments",
      paymentBody(f, 2000, { allocations: [{ billId: open.id, amountMinor: 1000 }, { billId: open.id, amountMinor: 1000 }] }),
    );
    const otherWithoutAccount = await rawPost("/supplier-payments", paymentBody(f, 1000, { method: "OTHER", paidFromAccountId: undefined }));
    const zero = await rawPost("/supplier-payments", paymentBody(f, 0));
    const unknownSupplier = await rawPost("/supplier-payments", paymentBody(f, 1000, { supplierId: randomUUID() }));
    const repeated = await rawPost("/supplier-payments", paymentBody(f, 1000, { clientUuid }));

    expect([overAllocated.status, twice.status, otherWithoutAccount.status, zero.status]).toEqual([400, 400, 400, 400]);
    expect(unknownSupplier.status).toBe(404);
    expect(repeated.status).toBe(409);
  });
});

describe("POST /api/v1/supplier-bills/{id}/payments", () => {
  it("is recorded as a supplier payment applied to that bill", async () => {
    const f = await makeFixture();
    const open = await postedBill(f, 50000);

    const paid = await post(`/supplier-bills/${open.id}/payments`, {
      clientUuid: randomUUID(),
      amountMinor: 20000,
      date: today,
      paidFromAccountId: f.bankAccountId,
      method: "CHEQUE",
      reference: "004513",
    });
    const payments = (await get(`/supplier-payments?supplier_id=${f.supplierId}`)).body.data;

    expect(paid).toMatchObject({ status: "PART_PAID", balance_due_minor: "30000" });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ amount_minor: "20000", applied_minor: "20000", method: "CHEQUE", reference: "004513" });
    expect(paid.allocations[0]).toMatchObject({ supplier_payment_id: payments[0].id, journal_id: payments[0].journal_id });
  });
});

describe("GET /api/v1/supplier-payments", () => {
  it("lists newest first, filtered by supplier, method, credit, date or search", async () => {
    const f = await makeFixture();
    await postedBill(f, 10000);
    const cash = await post("/supplier-payments", paymentBody(f, 8000, { method: "CASH", reference: `R-${f.supplierId.slice(0, 6)}` }));
    const credit = await post("/supplier-payments", paymentBody(f, 5000, { method: "MPESA" }));

    const ids = async (query: string) =>
      (await get(`/supplier-payments?supplier_id=${f.supplierId}${query}`)).body.data.map((p: { id: string }) => p.id);

    expect(await ids("")).toEqual([credit.id, cash.id]);
    expect(await ids("&method=CASH")).toEqual([cash.id]);
    expect(await ids("&has_credit=true")).toEqual([credit.id]); // pays the 2,000 still owed; 3,000 is credit
    expect(await ids("&has_credit=false")).toEqual([cash.id]);
    expect(await ids(`&from=${addDays(today, 1)}`)).toEqual([]);
    expect(await ids(`&q=${encodeURIComponent(cash.reference)}`)).toEqual([cash.id]);
    expect(await ids(`&q=${encodeURIComponent(credit.number)}`)).toEqual([credit.id]);
    expect((await get(`/supplier-payments?q=${encodeURIComponent(f.supplierName)}`)).body.data).toHaveLength(2);
    expect((await get(`/supplier-payments?supplier_id=${f.supplierId}`)).body.data[0].allocations).toBeUndefined();
  });

  it("pages with a cursor, and answers 404 for an unknown payment", async () => {
    const f = await makeFixture();
    await postedBill(f, 10000);
    const made = [];
    for (let i = 0; i < 3; i++) {
      made.push((await post("/supplier-payments", paymentBody(f, 1000))).id);
    }

    const page = (await get(`/supplier-payments?supplier_id=${f.supplierId}&limit=2`)).body;
    const next = (await get(`/supplier-payments?supplier_id=${f.supplierId}&limit=2&cursor=${page.next_cursor}`)).body;
    const one = (await get(`/supplier-payments/${made[0]}`)).body;
    const missing = await get(`/supplier-payments/${randomUUID()}`);

    expect(page.data.map((p: { id: string }) => p.id)).toEqual([made[2], made[1]]);
    expect(page.has_more).toBe(true);
    expect(next.data.map((p: { id: string }) => p.id)).toEqual([made[0]]);
    expect(one).toMatchObject({ id: made[0], allocations: [expect.objectContaining({ amount_minor: "1000" })] });
    expect(missing.status).toBe(404);
    expect(missing.body.title).toBe("SUPPLIER_PAYMENT_NOT_FOUND");
  });
});
