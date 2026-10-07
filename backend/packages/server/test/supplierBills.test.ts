/**
 * Supplier bills and debit notes (FR-AP-02) and payables aging (FR-AP-03).
 * Bills share the invoice engine; these tests check the supplier side's
 * own rules, names and journals, and that the two sides never mix.
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
  // Claiming input VAT needs a VAT-registered business.
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

async function call(method: "get" | "post" | "patch", path: string, body?: object) {
  const req = request(app)[method](`/api/v1${path}`).set(await auth());
  return body ? req.send(body) : req;
}

async function ok(method: "get" | "post" | "patch", path: string, body?: object) {
  const response = await call(method, path, body);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  return response.body;
}

interface Fixture {
  supplierId: string;
  apAccountId: string;
  expenseAccountId: string;
  stockAccountId: string;
  vatAccountId: string;
  bankAccountId: string;
}

async function makeFixture(): Promise<Fixture> {
  const account = async (name: string, type: string) =>
    (await ok("post", "/accounts", { code: randomUUID().slice(0, 8), name, type })).id as string;
  return {
    supplierId: (await ok("post", "/suppliers", { name: `Bill Supplier ${randomUUID().slice(0, 8)}`, paymentTermsDays: 14 })).id,
    apAccountId: await account("AP Test", "LIABILITY"),
    expenseAccountId: await account("Rent Test", "EXPENSE"),
    stockAccountId: await account("Purchases Test", "EXPENSE"),
    vatAccountId: await account("Input VAT Test", "ASSET"),
    bankAccountId: await account("Bank Test", "ASSET"),
  };
}

function billBody(f: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    clientUuid: randomUUID(),
    supplierId: f.supplierId,
    payableAccountId: f.apAccountId,
    billDate: today,
    supplierReference: `SUP-${randomUUID().slice(0, 6)}`,
    lines: [{ description: "Shop rent", quantity: 1, unitPriceMinor: 50000, expenseAccountId: f.expenseAccountId }],
    ...overrides,
  };
}

async function postedBill(f: Fixture, overrides: Record<string, unknown> = {}) {
  const draft = await ok("post", "/supplier-bills", billBody(f, overrides));
  return ok("post", `/supplier-bills/${draft.id}/post`);
}

async function journalLines(journalId: string) {
  return withTenant(TEST_TENANT_ID, async (client) => {
    const result = await client.query(
      `SELECT account_id, debit_minor, credit_minor, supplier_id, customer_id FROM journal_lines WHERE journal_id = $1`,
      [journalId],
    );
    return result.rows;
  });
}

// Each test seeds accounts and a supplier through ten-plus API calls.
describe("supplier bills", { timeout: 20_000 }, () => {
  it("drafts with input VAT and a due date from the supplier's terms, in bill field names", async () => {
    const f = await makeFixture();

    const draft = await ok(
      "post",
      "/supplier-bills",
      billBody(f, {
        taxMode: "EXCLUSIVE",
        lines: [
          {
            description: "Maize 90kg bags",
            quantity: 4,
            unitPriceMinor: 300000,
            expenseAccountId: f.stockAccountId,
            taxRateBps: 1600,
            taxAccountId: f.vatAccountId,
          },
        ],
      }),
    );

    expect(draft).toMatchObject({
      kind: "BILL",
      status: "DRAFT",
      number: null,
      supplier_id: f.supplierId,
      payable_account_id: f.apAccountId,
      bill_date: today,
      due_date: addDays(today, 14),
      subtotal_minor: "1200000",
      tax_minor: "192000",
      total_minor: "1392000",
    });
    expect(draft.supplier_name).toMatch(/^Bill Supplier/);
    expect(draft.lines[0]).toMatchObject({ expense_account_id: f.stockAccountId, tax_minor: "192000" });
    expect(draft.customer_id).toBeUndefined();
    expect(draft.receivable_account_id).toBeUndefined();
  });

  it("posts Dr expense / Dr input VAT / Cr payable for the supplier, with a BILL number", async () => {
    const f = await makeFixture();

    const bill = await postedBill(f, {
      taxMode: "EXCLUSIVE",
      lines: [
        {
          description: "Stock",
          quantity: 1,
          unitPriceMinor: 100000,
          expenseAccountId: f.stockAccountId,
          taxRateBps: 1600,
          taxAccountId: f.vatAccountId,
        },
      ],
    });

    expect(bill).toMatchObject({ status: "ISSUED", balance_due_minor: "116000" });
    expect(bill.number).toMatch(/^BILL-\d{6,}$/);
    expect(bill.posted_at).toBeTruthy();
    expect(await journalLines(bill.journal_id)).toEqual(
      expect.arrayContaining([
        { account_id: f.stockAccountId, debit_minor: "100000", credit_minor: "0", supplier_id: null, customer_id: null },
        { account_id: f.vatAccountId, debit_minor: "16000", credit_minor: "0", supplier_id: null, customer_id: null },
        { account_id: f.apAccountId, debit_minor: "0", credit_minor: "116000", supplier_id: f.supplierId, customer_id: null },
      ]),
    );
  });

  it("refuses the same supplier invoice twice, but allows it after the first is cancelled", async () => {
    const f = await makeFixture();
    const other = await makeFixture();
    const first = await postedBill(f, { supplierReference: "INV-7788" });

    const duplicate = await call("post", "/supplier-bills", billBody(f, { supplierReference: "INV-7788" }));
    const otherSupplier = await call("post", "/supplier-bills", billBody(other, { supplierReference: "INV-7788" }));
    await ok("post", `/supplier-bills/${first.id}/cancel`, { reason: "Entered against the wrong account" });
    const reentered = await call("post", "/supplier-bills", billBody(f, { supplierReference: "INV-7788" }));

    expect(duplicate.status).toBe(409);
    expect(otherSupplier.status).toBe(201);
    expect(reentered.status).toBe(201);
  });

  it("pays in parts -- Dr payable (supplier) / Cr bank -- and refuses overpaying", async () => {
    const f = await makeFixture();
    const bill = await postedBill(f); // 500.00
    const pay = (amountMinor: number) =>
      call("post", `/supplier-bills/${bill.id}/payments`, {
        clientUuid: randomUUID(),
        amountMinor,
        date: today,
        paidFromAccountId: f.bankAccountId,
        method: "BANK",
      });

    const part = await pay(20000);
    const over = await pay(30001);
    const rest = await pay(30000);

    expect(part.status).toBe(201);
    expect(part.body).toMatchObject({ status: "PART_PAID", balance_due_minor: "30000" });
    expect(over.status).toBe(422);
    expect(over.body.title).toBe("INVOICE_OVERPAYMENT");
    expect(rest.body).toMatchObject({ status: "PAID", balance_due_minor: "0" });
    expect(rest.body.allocations[1]).toMatchObject({ method: "BANK", paid_from_account_id: f.bankAccountId });
    expect(await journalLines(rest.body.allocations[1].journal_id)).toEqual(
      expect.arrayContaining([
        { account_id: f.apAccountId, debit_minor: "30000", credit_minor: "0", supplier_id: f.supplierId, customer_id: null },
        { account_id: f.bankAccountId, debit_minor: "0", credit_minor: "30000", supplier_id: null, customer_id: null },
      ]),
    );
  });

  it("cancels an unpaid bill by reversal, and refuses once paid", async () => {
    const f = await makeFixture();
    const unpaid = await postedBill(f);
    const paid = await postedBill(f);
    await ok("post", `/supplier-bills/${paid.id}/payments`, {
      clientUuid: randomUUID(),
      amountMinor: 100,
      date: today,
      paidFromAccountId: f.bankAccountId,
    });

    const cancelled = await call("post", `/supplier-bills/${unpaid.id}/cancel`, { reason: "Duplicate" });
    const refused = await call("post", `/supplier-bills/${paid.id}/cancel`, { reason: "x" });

    expect(cancelled.body.status).toBe("CANCELLED");
    expect(await journalLines(cancelled.body.cancel_journal_id)).toEqual(
      expect.arrayContaining([
        { account_id: f.apAccountId, debit_minor: "50000", credit_minor: "0", supplier_id: f.supplierId, customer_id: null },
      ]),
    );
    expect(refused.status).toBe(422);
    expect(refused.body.title).toBe("INVOICE_HAS_PAYMENTS");
  });

  it("applies a posted debit note to its bill: Dr payable / Cr expense", async () => {
    const f = await makeFixture();
    const bill = await postedBill(f);

    const note = await ok("post", `/supplier-bills/${bill.id}/debit-notes`, {
      clientUuid: randomUUID(),
      notes: "Overcharged",
      lines: [{ description: "Rent overcharge", quantity: 1, unitPriceMinor: 5000, expenseAccountId: f.expenseAccountId }],
    });
    const posted = await ok("post", `/supplier-bills/${note.id}/post`);
    const after = await ok("get", `/supplier-bills/${bill.id}`);
    const tooMuch = await call("post", `/supplier-bills/${bill.id}/debit-notes`, {
      clientUuid: randomUUID(),
      lines: [{ description: "x", quantity: 1, unitPriceMinor: 45001, expenseAccountId: f.expenseAccountId }],
    });

    expect(note).toMatchObject({ kind: "DEBIT_NOTE", debited_bill_id: bill.id, supplier_id: f.supplierId });
    expect(posted.number).toMatch(/^DN-\d{6,}$/);
    expect(await journalLines(posted.journal_id)).toEqual(
      expect.arrayContaining([
        { account_id: f.apAccountId, debit_minor: "5000", credit_minor: "0", supplier_id: f.supplierId, customer_id: null },
        { account_id: f.expenseAccountId, debit_minor: "0", credit_minor: "5000", supplier_id: null, customer_id: null },
      ]),
    );
    expect(after).toMatchObject({ status: "PART_PAID", balance_due_minor: "45000" });
    expect(after.allocations[0]).toMatchObject({ method: "DEBIT_NOTE", debit_note_id: note.id });
    expect(tooMuch.status).toBe(422);
  });

  it("never mixes with invoices: each side 404s the other's documents", async () => {
    const f = await makeFixture();
    const bill = await postedBill(f);

    const asInvoice = await call("get", `/invoices/${bill.id}`);
    const payAsInvoice = await call("post", `/invoices/${bill.id}/payments`, {
      clientUuid: randomUUID(),
      amountMinor: 100,
      date: today,
      receivedAccountId: f.bankAccountId,
    });
    const invoices = await ok("get", `/invoices?limit=200`);
    const badKind = await call("get", `/invoices?kind=BILL`);

    expect(asInvoice.status).toBe(404);
    expect(payAsInvoice.status).toBe(404);
    expect(invoices.data.find((i: { id: string }) => i.id === bill.id)).toBeUndefined();
    expect(badKind.status).toBe(400);
  });

  it("lists by supplier with paging", async () => {
    const f = await makeFixture();
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await ok("post", "/supplier-bills", billBody(f))).id);
    }

    const page = await ok("get", `/supplier-bills?supplier_id=${f.supplierId}&limit=2`);
    const next = await ok("get", `/supplier-bills?supplier_id=${f.supplierId}&limit=2&cursor=${page.next_cursor}`);

    expect(page.data.map((b: { id: string }) => b.id)).toEqual([ids[2], ids[1]]);
    expect(page.has_more).toBe(true);
    expect(next.data.map((b: { id: string }) => b.id)).toEqual([ids[0]]);
  });
});

describe("GET /api/v1/payables-aging", { timeout: 20_000 }, () => {
  it("ages open bills per supplier, keeps guided bills apart, and drills down", async () => {
    const f = await makeFixture(); // terms 14 days
    const a = await postedBill(f); // 500.00 due today + 14
    const b = await postedBill(f, { dueDate: today, lines: [{ description: "Stock", quantity: 1, unitPriceMinor: 80000, expenseAccountId: f.stockAccountId }] });
    await ok("post", `/supplier-bills/${b.id}/payments`, {
      clientUuid: randomUUID(),
      amountMinor: 30000,
      date: today,
      paidFromAccountId: f.bankAccountId,
    });
    // The older guided endpoint: posts to the supplier but leaves no bill record.
    await ok("post", "/bills", {
      clientUuid: randomUUID(),
      supplierId: f.supplierId,
      payableAccountId: f.apAccountId,
      date: today,
      currency: "KES",
      lines: [{ expenseAccountId: f.expenseAccountId, amountMinor: 12000 }],
    });

    const report = await ok("get", `/payables-aging?as_of=${addDays(today, 40)}`);
    const detail = await ok("get", `/payables-aging?as_of=${addDays(today, 40)}&supplier_id=${f.supplierId}`);

    const row = report.rows.find((r: { supplier_id: string }) => r.supplier_id === f.supplierId);
    // a is 26 days late (1-30); b's remaining 500.00 is 40 days late (31-60).
    expect(row).toMatchObject({
      days_1_30_minor: "50000",
      days_31_60_minor: "50000",
      billed_minor: "100000",
      not_billed_minor: "12000",
      balance_minor: "112000",
    });
    expect(row.supplier_name).toMatch(/^Bill Supplier/);
    expect(detail).toMatchObject({ supplier_id: f.supplierId, billed_minor: "100000", not_billed_minor: "12000" });
    expect(detail.bills).toEqual([
      expect.objectContaining({ id: b.id, bucket: "DAYS_31_60", days_past_due: 40, open_minor: "50000", bill_date: today }),
      expect.objectContaining({ id: a.id, bucket: "DAYS_1_30", days_past_due: 26, open_minor: "50000" }),
    ]);
  });

  it("answers 404 for an unknown supplier", async () => {
    const response = await call("get", `/payables-aging?supplier_id=${randomUUID()}`);
    expect(response.status).toBe(404);
  });
});
