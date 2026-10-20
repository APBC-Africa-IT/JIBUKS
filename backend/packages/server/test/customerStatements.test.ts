/**
 * Customer statements: POST/GET /customer-statements, the PDF, mark-sent,
 * and what goes on the PDF (buildStatementPdfModel, as plain strings).
 *
 * Everything is dated today; the statement period is today unless a test
 * says otherwise.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@jibuks/db";
import { SYSTEM_ROLES } from "@jibuks/domain";
import { createApp } from "../src/app.js";
import { buildStatementPdfModel, describeTransaction } from "../src/modules/customerStatements/pdf.js";
import type { StatementDetailView } from "../src/modules/customerStatements/service.js";
import type { CustomerTransaction } from "../src/modules/customerLedger/service.js";
import { listen } from "./testServer.js";
import { todayInNairobi } from "../src/modules/periods/service.js";
import { authHeader } from "./testAuth.js";

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

interface Fixture {
  customerId: string;
  customerName: string;
  arAccountId: string;
  salesAccountId: string;
  cashAccountId: string;
}

async function makeFixture(): Promise<Fixture> {
  const account = async (type: string) =>
    (await post("/accounts", { code: randomUUID().slice(0, 8), name: `Statement ${type}`, type })).id as string;
  const customerName = `Statement Customer ${randomUUID().slice(0, 8)}`;
  return {
    customerId: (await post("/customers", { name: customerName, paymentTermsDays: 30 })).id,
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

async function pay(f: Fixture, invoiceId: string, amountMinor: number) {
  return post(`/invoices/${invoiceId}/payments`, {
    clientUuid: randomUUID(),
    amountMinor,
    date: today,
    receivedAccountId: f.cashAccountId,
    method: "MPESA",
    reference: "QAB12CD34E",
  });
}

/** Invoice 1,000 with 300 paid, and a 400 credit sale (not invoiced): 1,100 owed. */
async function seedCustomer() {
  const f = await makeFixture();
  const invoice = await issueInvoice(f, 100000);
  await pay(f, invoice.id, 30000);
  await post("/credit-sales", {
    clientUuid: randomUUID(),
    customerId: f.customerId,
    receivableAccountId: f.arAccountId,
    date: today,
    currency: "KES",
    lines: [{ incomeAccountId: f.salesAccountId, amountMinor: 40000 }],
  });
  return { f, invoice };
}

async function issueStatement(f: Fixture, extra: Record<string, unknown> = { from: today, to: today }) {
  return post("/customer-statements", { clientUuid: randomUUID(), customerId: f.customerId, ...extra });
}

describe("POST /api/v1/customer-statements", () => {
  it("snapshots the customer's ledger and aging for the period", async () => {
    const { f, invoice } = await seedCustomer();

    const statement = await issueStatement(f, { from: today, to: today, message: "Kindly settle by the 5th" });

    expect(statement).toMatchObject({
      number: expect.stringMatching(/^ST-\d{6,}$/),
      customer_id: f.customerId,
      customer_name: f.customerName,
      period_from: today,
      period_to: today,
      opening_balance_minor: "0",
      total_debit_minor: "140000",
      total_credit_minor: "30000",
      closing_balance_minor: "110000",
      message: "Kindly settle by the 5th",
      status: "NOT_SENT",
      sent_at: null,
    });
    expect(statement.transactions.map((t: { type: string }) => t.type)).toEqual(["INVOICE", "PAYMENT", "CREDIT_SALE"]);
    expect(statement.transactions[1]).toMatchObject({ document_number: invoice.number, payment_method: "MPESA" });
    // Invoice not yet due: all current; the credit sale can't be aged.
    expect(statement.aging).toEqual({
      current_minor: "70000",
      days_1_30_minor: "0",
      days_31_60_minor: "0",
      days_61_90_minor: "0",
      days_over_90_minor: "0",
      not_invoiced_minor: "40000",
      balance_minor: "110000",
    });
  });

  it("defaults to the month to date", async () => {
    const { f } = await seedCustomer();

    const statement = await issueStatement(f, {});

    expect(statement).toMatchObject({ period_from: `${today.slice(0, 8)}01`, period_to: today, closing_balance_minor: "110000" });
  });

  it("keeps what was issued when the ledger moves on", async () => {
    const { f, invoice } = await seedCustomer();
    const statement = await issueStatement(f);

    await pay(f, invoice.id, 70000);
    const again = await get(`/customer-statements/${statement.id}`);

    expect(again.body.closing_balance_minor).toBe("110000");
    expect(again.body.transactions).toHaveLength(3);
    expect((await get(`/customers/${f.customerId}`)).body.balance_minor).toBe("40000");
  });

  it("numbers statements consecutively", async () => {
    const { f } = await seedCustomer();

    const first = await issueStatement(f);
    const second = await issueStatement(f);

    expect(Number(second.number.slice(3))).toBe(Number(first.number.slice(3)) + 1);
  });

  it("answers 404 for an unknown customer, 400 for a bad period and 409 for a repeated clientUuid", async () => {
    const { f } = await seedCustomer();
    const clientUuid = randomUUID();
    await issueStatement(f, { clientUuid });

    const unknown = await rawPost("/customer-statements", { clientUuid: randomUUID(), customerId: randomUUID() });
    const backwards = await rawPost("/customer-statements", { clientUuid: randomUUID(), customerId: f.customerId, from: today, to: "2020-01-01" });
    const future = await rawPost("/customer-statements", { clientUuid: randomUUID(), customerId: f.customerId, from: "2999-01-01" });
    const repeated = await rawPost("/customer-statements", { clientUuid, customerId: f.customerId });

    expect(unknown.status).toBe(404);
    expect(backwards.status).toBe(400);
    expect(future.status).toBe(400);
    expect(repeated.status).toBe(409);
  });
});

describe("GET /api/v1/customer-statements", () => {
  it("lists newest first without transaction rows, filtered by customer, sent status or search", async () => {
    const { f } = await seedCustomer();
    const older = await issueStatement(f);
    const newer = await issueStatement(f);
    await post(`/customer-statements/${older.id}/mark-sent`);

    const all = await get(`/customer-statements?customer_id=${f.customerId}`);
    const unsent = await get(`/customer-statements?customer_id=${f.customerId}&sent=false`);
    const sent = await get(`/customer-statements?customer_id=${f.customerId}&sent=true`);
    const search = await get(`/customer-statements?q=${encodeURIComponent(f.customerName.toLowerCase())}`);
    const byNumber = await get(`/customer-statements?q=${newer.number}`);

    expect(all.status).toBe(200);
    expect(all.body.data.map((s: { id: string }) => s.id)).toEqual([newer.id, older.id]);
    expect(all.body.data[0]).not.toHaveProperty("transactions");
    expect(all.body.data[1]).toMatchObject({ status: "SENT", closing_balance_minor: "110000" });
    expect(unsent.body.data.map((s: { id: string }) => s.id)).toEqual([newer.id]);
    expect(sent.body.data.map((s: { id: string }) => s.id)).toEqual([older.id]);
    expect(search.body.data.map((s: { id: string }) => s.id)).toEqual([newer.id, older.id]);
    expect(byNumber.body.data.map((s: { id: string }) => s.id)).toEqual([newer.id]);
  });

  it("pages with a cursor", async () => {
    const { f } = await seedCustomer();
    const older = await issueStatement(f);
    const newer = await issueStatement(f);

    const first = await get(`/customer-statements?customer_id=${f.customerId}&limit=1`);
    const second = await get(`/customer-statements?customer_id=${f.customerId}&limit=1&cursor=${first.body.next_cursor}`);
    const bad = await get("/customer-statements?cursor=nope");

    expect(first.body).toMatchObject({ has_more: true, data: [expect.objectContaining({ id: newer.id })] });
    expect(second.body).toMatchObject({ has_more: false, next_cursor: null, data: [expect.objectContaining({ id: older.id })] });
    expect(bad.status).toBe(400);
  });

  it("answers 404 for an unknown statement", async () => {
    expect((await get(`/customer-statements/${randomUUID()}`)).status).toBe(404);
    expect((await get(`/customer-statements/${randomUUID()}/pdf`)).status).toBe(404);
    expect((await rawPost(`/customer-statements/${randomUUID()}/mark-sent`)).status).toBe(404);
  });
});

describe("POST /api/v1/customer-statements/{id}/mark-sent", () => {
  it("marks it sent once; marking again keeps the first time", async () => {
    const { f } = await seedCustomer();
    const statement = await issueStatement(f);

    const first = await post(`/customer-statements/${statement.id}/mark-sent`);
    const second = await post(`/customer-statements/${statement.id}/mark-sent`);

    expect(first).toMatchObject({ status: "SENT", sent_at: expect.any(String), sent_by: expect.any(String) });
    expect(second.sent_at).toBe(first.sent_at);
  });
});

describe("GET /api/v1/customer-statements/{id}/pdf", () => {
  it("returns a PDF named after the statement", async () => {
    const { f } = await seedCustomer();
    const statement = await issueStatement(f);

    const response = await request(app)
      .get(`/api/v1/customer-statements/${statement.id}/pdf`)
      .set(await auth())
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["content-disposition"]).toBe(`inline; filename="${statement.number}.pdf"`);
    expect((response.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("statement permissions", () => {
  it("lets viewers see statements, and keeps cashiers out", () => {
    expect(SYSTEM_ROLES.VIEWER.permissions).toContain("statements:view");
    expect(SYSTEM_ROLES.VIEWER.permissions).not.toContain("statements:create");
    expect(SYSTEM_ROLES.ACCOUNTANT.permissions).toContain("statements:create");
    expect(SYSTEM_ROLES.CASHIER.permissions).not.toContain("statements:view");
  });
});

describe("buildStatementPdfModel", () => {
  function transaction(overrides: Partial<CustomerTransaction>): CustomerTransaction {
    return {
      journal_id: randomUUID(),
      journal_number: null,
      date: "2026-09-03",
      type: "INVOICE",
      document_id: null,
      document_kind: null,
      document_number: null,
      credited_invoice_id: null,
      credited_invoice_number: null,
      payment_method: null,
      reference: null,
      description: "",
      debit_minor: "0",
      credit_minor: "0",
      balance_minor: "0",
      ...overrides,
    };
  }

  function statement(overrides: Partial<StatementDetailView> = {}): StatementDetailView {
    return {
      id: randomUUID(),
      number: "ST-000007",
      customer_id: randomUUID(),
      customer_name: "Jane Traders",
      period_from: "2026-09-01",
      period_to: "2026-09-30",
      currency: null,
      opening_balance_minor: "30000",
      total_debit_minor: "100000",
      total_credit_minor: "30000",
      closing_balance_minor: "100000",
      aging: {
        current_minor: "70000",
        days_1_30_minor: "30000",
        days_31_60_minor: "0",
        days_61_90_minor: "0",
        days_over_90_minor: "0",
        not_invoiced_minor: "0",
        balance_minor: "100000",
      },
      message: null,
      status: "NOT_SENT",
      sent_at: null,
      sent_by: null,
      created_by: randomUUID(),
      created_at: "2026-10-01T08:00:00.000Z",
      transactions: [
        transaction({ type: "INVOICE", document_number: "INV-000124", debit_minor: "100000", balance_minor: "130000" }),
        transaction({
          date: "2026-09-10",
          type: "PAYMENT",
          document_number: "INV-000124",
          payment_method: "MPESA",
          reference: "QAB12CD34E",
          credit_minor: "30000",
          balance_minor: "100000",
        }),
      ],
      ...overrides,
    };
  }

  const parties = { business: { name: "Doris Salon", taxIdentifier: "P051234567X" }, customer: { name: "Jane Traders", taxIdentifier: null } };

  it("opens with the balance brought forward and closes on the amount due", () => {
    const model = buildStatementPdfModel({ statement: statement(), currency: "KES", ...parties });

    expect(model.rows).toEqual([
      { date: "1 Sept 2026", details: "Balance brought forward", charges: "", payments: "", balance: "KES 300.00" },
      { date: "3 Sept 2026", details: "Invoice INV-000124", charges: "KES 1,000.00", payments: "", balance: "KES 1,300.00" },
      { date: "10 Sept 2026", details: "Payment (M-Pesa QAB12CD34E) - INV-000124", charges: "", payments: "KES 300.00", balance: "KES 1,000.00" },
    ]);
    expect(model.highlight).toEqual(["Amount due", "KES 1,000.00"]);
    expect(model.aging.map(([label]) => label)).toEqual(["Current", "1-30 days", "31-60 days", "61-90 days", "Over 90 days"]);
    expect(model.filename).toBe("ST-000007.pdf");
  });

  it("shows a credit balance as such, and an amount not invoiced in the aging", () => {
    const model = buildStatementPdfModel({
      statement: statement({
        closing_balance_minor: "-5000",
        aging: { ...statement().aging, not_invoiced_minor: "-5000" },
      }),
      currency: "KES",
      ...parties,
    });

    expect(model.highlight).toEqual(["Credit balance", "KES 50.00"]);
    expect(model.aging.at(-1)).toEqual(["Not invoiced", "KES -50.00"]);
  });

  it("names each kind of transaction for the customer", () => {
    expect(describeTransaction(transaction({ type: "CREDIT_NOTE", document_number: "CN-000003", credited_invoice_number: "INV-000124" }))).toBe(
      "Credit note CN-000003 - INV-000124",
    );
    expect(describeTransaction(transaction({ type: "INVOICE_CANCELLED", document_number: "INV-000125" }))).toBe("Invoice INV-000125 cancelled");
    expect(describeTransaction(transaction({ type: "OPENING_BALANCE" }))).toBe("Opening balance");
    expect(describeTransaction(transaction({ type: "PAYMENT" }))).toBe("Payment");
    expect(describeTransaction(transaction({ type: "JOURNAL", description: "Write-off" }))).toBe("Write-off");
  });
});
