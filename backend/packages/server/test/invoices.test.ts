/**
 * Invoices: drafts, issue, payments, cancel, credit notes, pro-formas and
 * M-Pesa collection against an invoice (FR-AR-02/05, FR-PAY-04, FR-TAX-01).
 *
 * Dates are today (Africa/Nairobi) unless a test needs the past, so the
 * current period is opened automatically and no invoice turns OVERDUE as
 * the calendar moves on.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@jibuks/db";
import { createApp } from "../src/app.js";
import { todayInNairobi } from "../src/modules/periods/service.js";
import { onboard } from "../src/modules/onboarding/service.js";
import * as invoicesService from "../src/modules/invoices/service.js";
import * as customersService from "../src/modules/customers/service.js";
import {
  setDarajaClientForTesting,
  type DarajaClient,
  type StkPushRequest,
  type StkQueryResult,
} from "../src/modules/payments/daraja.js";
import { authHeader, TEST_TENANT_ID } from "./testAuth.js";

const app = createApp();
const today = todayInNairobi();

beforeAll(async () => {
  // Charging VAT needs a VAT-registered business.
  await withTenant(TEST_TENANT_ID, async (client) => {
    await client.query(`UPDATE tenants SET vat_registered = true WHERE id = $1`, [TEST_TENANT_ID]);
  });
});

afterAll(async () => {
  setDarajaClientForTesting(null);
  await closePool();
});

interface Fixture {
  arAccountId: string;
  salesAccountId: string;
  serviceAccountId: string;
  vatAccountId: string;
  cashAccountId: string;
  mpesaAccountId: string;
  customerId: string;
}

async function auth() {
  return { Authorization: await authHeader() };
}

async function makeFixture(customer: Record<string, unknown> = {}): Promise<Fixture> {
  const account = async (name: string, type: string) => {
    const response = await request(app)
      .post("/api/v1/accounts")
      .set(await auth())
      .send({ code: randomUUID().slice(0, 8), name, type });
    expect(response.status).toBe(201);
    return response.body.id as string;
  };
  const created = await request(app)
    .post("/api/v1/customers")
    .set(await auth())
    .send({ name: `Invoice Customer ${randomUUID().slice(0, 8)}`, ...customer });
  expect(created.status).toBe(201);
  return {
    arAccountId: await account("AR Test", "ASSET"),
    salesAccountId: await account("Sales Test", "INCOME"),
    serviceAccountId: await account("Service Revenue Test", "INCOME"),
    vatAccountId: await account("Output VAT Test", "LIABILITY"),
    cashAccountId: await account("Cash Test", "ASSET"),
    mpesaAccountId: await account("M-Pesa Test", "ASSET"),
    customerId: created.body.id as string,
  };
}

function draftBody(f: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    clientUuid: randomUUID(),
    customerId: f.customerId,
    receivableAccountId: f.arAccountId,
    issueDate: today,
    lines: [{ description: "Maize flour 2kg", quantity: 2, unitPriceMinor: 25000, incomeAccountId: f.salesAccountId }],
    ...overrides,
  };
}

async function createDraft(body: object) {
  return request(app).post("/api/v1/invoices").set(await auth()).send(body);
}

async function post(path: string, body: object = {}) {
  return request(app).post(`/api/v1/invoices${path}`).set(await auth()).send(body);
}

async function get(id: string) {
  return request(app).get(`/api/v1/invoices/${id}`).set(await auth());
}

/** Creates and issues an invoice, returning the issued body. */
async function issuedInvoice(f: Fixture, overrides: Record<string, unknown> = {}) {
  const draft = await createDraft(draftBody(f, overrides));
  expect(draft.status).toBe(201);
  const issued = await post(`/${draft.body.id}/issue`);
  expect(issued.status).toBe(200);
  return issued.body;
}

async function journalLines(journalId: string) {
  return withTenant(TEST_TENANT_ID, async (client) => {
    const result = await client.query<{
      account_id: string;
      debit_minor: string;
      credit_minor: string;
      customer_id: string | null;
    }>(`SELECT account_id, debit_minor, credit_minor, customer_id FROM journal_lines WHERE journal_id = $1`, [
      journalId,
    ]);
    return result.rows;
  });
}

describe("invoice drafts", () => {
  it("computes exclusive VAT per line, a due date from the customer's terms, and no number or journal", async () => {
    const f = await makeFixture({ paymentTermsDays: 30 });

    const response = await createDraft(
      draftBody(f, {
        taxMode: "EXCLUSIVE",
        lines: [
          {
            description: "Sugar 1kg",
            quantity: 3,
            unitPriceMinor: 15050,
            incomeAccountId: f.salesAccountId,
            taxRateBps: 1600,
            taxAccountId: f.vatAccountId,
          },
          { description: "Delivery (zero-rated)", quantity: 1, unitPriceMinor: 20000, incomeAccountId: f.serviceAccountId },
        ],
      }),
    );

    expect(response.status).toBe(201);
    // 3 x 150.50 = 451.50 net, 16% = 72.24 tax; delivery 200.00 untaxed.
    expect(response.body).toMatchObject({
      kind: "INVOICE",
      status: "DRAFT",
      number: null,
      journal_id: null,
      subtotal_minor: "65150",
      tax_minor: "7224",
      total_minor: "72374",
      balance_due_minor: "0",
      currency: "KES",
    });
    const due = new Date(`${today}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + 30);
    expect(response.body.due_date).toBe(due.toISOString().slice(0, 10));
    expect(response.body.lines).toHaveLength(2);
    expect(response.body.lines[0]).toMatchObject({ line_no: 1, net_minor: "45150", tax_minor: "7224", total_minor: "52374" });
  });

  it("extracts VAT from tax-inclusive prices, rounding half up", async () => {
    const f = await makeFixture();

    const response = await createDraft(
      draftBody(f, {
        taxMode: "INCLUSIVE",
        lines: [
          {
            description: "Soda 500ml",
            quantity: 1,
            unitPriceMinor: 11600,
            incomeAccountId: f.salesAccountId,
            taxRateBps: 1600,
            taxAccountId: f.vatAccountId,
          },
          {
            description: "Bread",
            quantity: 1,
            unitPriceMinor: 6500,
            incomeAccountId: f.salesAccountId,
            taxRateBps: 1600,
            taxAccountId: f.vatAccountId,
          },
        ],
      }),
    );

    expect(response.status).toBe(201);
    // 116.00 -> 100.00 + 16.00; 65.00 x 16/116 = 8.9655 -> 8.97 tax, 56.03 net.
    expect(response.body.lines.map((l: { net_minor: string; tax_minor: string }) => [l.net_minor, l.tax_minor])).toEqual([
      ["10000", "1600"],
      ["5603", "897"],
    ]);
    expect(response.body).toMatchObject({ subtotal_minor: "15603", tax_minor: "2497", total_minor: "18100" });
  });

  it("rejects a tax rate without a tax account, or under taxMode NONE, with 400", async () => {
    const f = await makeFixture();
    const line = { description: "x", quantity: 1, unitPriceMinor: 100, incomeAccountId: f.salesAccountId, taxRateBps: 1600 };

    const noAccount = await createDraft(draftBody(f, { taxMode: "EXCLUSIVE", lines: [line] }));
    const noneMode = await createDraft(draftBody(f, { lines: [{ ...line, taxAccountId: f.vatAccountId }] }));
    const noReceivable = await createDraft(draftBody(f, { receivableAccountId: undefined }));

    expect([noAccount.status, noneMode.status, noReceivable.status]).toEqual([400, 400, 400]);
  });

  it("rejects an unknown customer or account with 404 and a zero total with 422", async () => {
    const f = await makeFixture();

    const customer = await createDraft(draftBody(f, { customerId: randomUUID() }));
    const account = await createDraft(
      draftBody(f, { lines: [{ description: "x", quantity: 1, unitPriceMinor: 100, incomeAccountId: randomUUID() }] }),
    );
    const zero = await createDraft(
      draftBody(f, { lines: [{ description: "Free sample", quantity: 1, unitPriceMinor: 0, incomeAccountId: f.salesAccountId }] }),
    );

    expect(customer.status).toBe(404);
    expect(account.status).toBe(404);
    expect(zero.status).toBe(422);
  });

  it("refuses VAT for a business that isn't VAT-registered", async () => {
    const { tenant, user } = await onboard({
      tenantName: "No-VAT Invoice Kiosk",
      tenantType: "BUSINESS",
      baseCurrency: "KES",
      externalIdpSubject: `test|${randomUUID()}`,
      userName: "Founder",
      vatRegistered: false,
      periodStartDate: "2026-10-01",
    });
    const customer = await customersService.createCustomer({ tenantId: tenant.id, name: "Walk-in" }, { actorUserId: user.id });

    await expect(
      invoicesService.createInvoice(
        {
          tenantId: tenant.id,
          clientUuid: randomUUID(),
          kind: "INVOICE",
          customerId: customer.id,
          receivableAccountId: randomUUID(),
          issueDate: today,
          taxMode: "EXCLUSIVE",
          lines: [
            {
              description: "x",
              quantity: 1,
              unitPriceMinor: 100,
              incomeAccountId: randomUUID(),
              taxRateBps: 1600,
              taxAccountId: randomUUID(),
            },
          ],
        },
        { actorUserId: user.id },
      ),
    ).rejects.toMatchObject({ code: "TAX_NOT_REGISTERED" });
  });

  it("PATCH replaces the lines and recomputes; DELETE removes a draft", async () => {
    const f = await makeFixture();
    const draft = await createDraft(draftBody(f));

    const patched = await request(app)
      .patch(`/api/v1/invoices/${draft.body.id}`)
      .set(await auth())
      .send({
        notes: "Thank you",
        lines: [{ description: "Rice 5kg", quantity: 1.5, unitPriceMinor: 70000, incomeAccountId: f.salesAccountId }],
      });
    const deleted = await request(app).delete(`/api/v1/invoices/${draft.body.id}`).set(await auth());
    const gone = await get(draft.body.id);

    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ notes: "Thank you", total_minor: "105000" });
    expect(patched.body.lines).toHaveLength(1);
    expect(patched.body.lines[0].quantity).toBe("1.500");
    expect(deleted.status).toBe(204);
    expect(gone.status).toBe(404);
  });
});

describe("issuing an invoice", () => {
  it("numbers it, posts Dr receivable (customer) / Cr income / Cr VAT, and makes it read-only", async () => {
    const f = await makeFixture();
    const draft = await createDraft(
      draftBody(f, {
        taxMode: "EXCLUSIVE",
        lines: [
          {
            description: "Cement bag",
            quantity: 2,
            unitPriceMinor: 50000,
            incomeAccountId: f.salesAccountId,
            taxRateBps: 1600,
            taxAccountId: f.vatAccountId,
          },
        ],
      }),
    );

    const issued = await post(`/${draft.body.id}/issue`);
    const again = await post(`/${draft.body.id}/issue`);
    const patch = await request(app).patch(`/api/v1/invoices/${draft.body.id}`).set(await auth()).send({ notes: "x" });
    const del = await request(app).delete(`/api/v1/invoices/${draft.body.id}`).set(await auth());

    expect(issued.status).toBe(200);
    expect(issued.body).toMatchObject({ status: "ISSUED", total_minor: "116000", balance_due_minor: "116000" });
    expect(issued.body.number).toMatch(/^INV-\d{6,}$/);
    const lines = await journalLines(issued.body.journal_id);
    expect(lines).toEqual(
      expect.arrayContaining([
        { account_id: f.arAccountId, debit_minor: "116000", credit_minor: "0", customer_id: f.customerId },
        { account_id: f.salesAccountId, debit_minor: "0", credit_minor: "100000", customer_id: null },
        { account_id: f.vatAccountId, debit_minor: "0", credit_minor: "16000", customer_id: null },
      ]),
    );
    expect(lines).toHaveLength(3);
    expect([again.status, patch.status, del.status]).toEqual([422, 422, 422]);
  });

  it("gives consecutive numbers", async () => {
    const f = await makeFixture();

    const first = await issuedInvoice(f);
    const second = await issuedInvoice(f);

    const seq = (n: string) => Number(n.slice(4));
    expect(seq(second.number)).toBe(seq(first.number) + 1);
  });

  it("blocks an invoice past the customer's credit limit unless overridden", async () => {
    const f = await makeFixture({ creditLimitMinor: 60000 });
    await issuedInvoice(f); // 500.00 owed
    const draft = await createDraft(draftBody(f)); // another 500.00

    const blocked = await post(`/${draft.body.id}/issue`);
    const overridden = await post(`/${draft.body.id}/issue`, { overrideCreditLimit: true });

    expect(blocked.status).toBe(422);
    expect(blocked.body.title).toBe("CREDIT_LIMIT_EXCEEDED");
    expect(overridden.status).toBe(200);
    expect(overridden.body.credit_limit_overridden).toBe(true);
  });

  it("shows an issued invoice past its due date as OVERDUE, and filters by it", async () => {
    const f = await makeFixture();
    await withTenant(TEST_TENANT_ID, async (client) => {
      await client.query(`INSERT INTO periods (tenant_id, start_date, end_date) VALUES ($1, '2026-09-01', '2026-09-30')`, [
        TEST_TENANT_ID,
      ]);
    });
    const late = await issuedInvoice(f, { issueDate: "2026-09-01", dueDate: "2026-09-02" });

    const overdue = await request(app).get(`/api/v1/invoices?status=OVERDUE&customer_id=${f.customerId}`).set(await auth());
    const issued = await request(app).get(`/api/v1/invoices?status=ISSUED&customer_id=${f.customerId}`).set(await auth());

    expect(late.status).toBe("OVERDUE");
    expect(overdue.body.data.map((i: { id: string }) => i.id)).toEqual([late.id]);
    expect(issued.body.data).toHaveLength(0);
  });
});

describe("payments against an invoice", () => {
  it("moves it to PART_PAID then PAID, posting Dr cash / Cr receivable for the customer", async () => {
    const f = await makeFixture();
    const invoice = await issuedInvoice(f); // 500.00
    const pay = (amountMinor: number) =>
      post(`/${invoice.id}/payments`, {
        clientUuid: randomUUID(),
        amountMinor,
        date: today,
        receivedAccountId: f.cashAccountId,
        reference: "RCPT-1",
      });

    const part = await pay(20000);
    const rest = await pay(30000);

    expect(part.status).toBe(201);
    expect(part.body).toMatchObject({ status: "PART_PAID", amount_paid_minor: "20000", balance_due_minor: "30000" });
    expect(rest.body).toMatchObject({ status: "PAID", amount_paid_minor: "50000", balance_due_minor: "0" });
    expect(rest.body.allocations).toHaveLength(2);
    expect(await journalLines(rest.body.allocations[1].journal_id)).toEqual(
      expect.arrayContaining([
        { account_id: f.cashAccountId, debit_minor: "30000", credit_minor: "0", customer_id: null },
        { account_id: f.arAccountId, debit_minor: "0", credit_minor: "30000", customer_id: f.customerId },
      ]),
    );
  });

  it("refuses more than the balance, and payments on a draft, with 422 and posts nothing", async () => {
    const f = await makeFixture();
    const invoice = await issuedInvoice(f);
    const draft = await createDraft(draftBody(f));
    const body = { clientUuid: randomUUID(), amountMinor: 50001, date: today, receivedAccountId: f.cashAccountId };

    const over = await post(`/${invoice.id}/payments`, body);
    const onDraft = await post(`/${draft.body.id}/payments`, { ...body, amountMinor: 100 });
    const after = await get(invoice.id);

    expect(over.status).toBe(422);
    expect(over.body.title).toBe("INVOICE_OVERPAYMENT");
    expect(onDraft.status).toBe(422);
    expect(after.body.allocations).toHaveLength(0);
  });
});

describe("cancelling", () => {
  it("reverses an unpaid invoice's journal", async () => {
    const f = await makeFixture();
    const invoice = await issuedInvoice(f);

    const cancelled = await post(`/${invoice.id}/cancel`, { reason: "Customer changed their mind" });

    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: "CANCELLED", cancel_reason: "Customer changed their mind", balance_due_minor: "0" });
    expect(await journalLines(cancelled.body.cancel_journal_id)).toEqual(
      expect.arrayContaining([
        { account_id: f.arAccountId, debit_minor: "0", credit_minor: "50000", customer_id: f.customerId },
        { account_id: f.salesAccountId, debit_minor: "50000", credit_minor: "0", customer_id: null },
      ]),
    );
  });

  it("refuses once a payment has been applied, and refuses drafts", async () => {
    const f = await makeFixture();
    const invoice = await issuedInvoice(f);
    await post(`/${invoice.id}/payments`, { clientUuid: randomUUID(), amountMinor: 100, date: today, receivedAccountId: f.cashAccountId });
    const draft = await createDraft(draftBody(f));

    const paid = await post(`/${invoice.id}/cancel`, { reason: "x" });
    const onDraft = await post(`/${draft.body.id}/cancel`, { reason: "x" });

    expect(paid.status).toBe(422);
    expect(paid.body.title).toBe("INVOICE_HAS_PAYMENTS");
    expect(onDraft.status).toBe(422);
  });
});

describe("credit notes", () => {
  it("posts the mirror journal and applies itself to the invoice when issued", async () => {
    const f = await makeFixture();
    const invoice = await issuedInvoice(f); // 500.00

    const draft = await post(`/${invoice.id}/credit-notes`, {
      clientUuid: randomUUID(),
      notes: "One bag returned damaged",
      lines: [{ description: "Maize flour 2kg returned", quantity: 1, unitPriceMinor: 25000, incomeAccountId: f.salesAccountId }],
    });
    const issued = await post(`/${draft.body.id}/issue`);
    const original = await get(invoice.id);

    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({ kind: "CREDIT_NOTE", status: "DRAFT", credited_invoice_id: invoice.id, customer_id: f.customerId });
    expect(issued.status).toBe(200);
    expect(issued.body.number).toMatch(/^CN-\d{6,}$/);
    expect(await journalLines(issued.body.journal_id)).toEqual(
      expect.arrayContaining([
        { account_id: f.arAccountId, debit_minor: "0", credit_minor: "25000", customer_id: f.customerId },
        { account_id: f.salesAccountId, debit_minor: "25000", credit_minor: "0", customer_id: null },
      ]),
    );
    expect(original.body).toMatchObject({ status: "PART_PAID", amount_paid_minor: "25000", balance_due_minor: "25000" });
    expect(original.body.allocations[0]).toMatchObject({ method: "CREDIT_NOTE", credit_note_id: draft.body.id });
  });

  it("can't credit more than is still owed", async () => {
    const f = await makeFixture();
    const invoice = await issuedInvoice(f);

    const response = await post(`/${invoice.id}/credit-notes`, {
      clientUuid: randomUUID(),
      lines: [{ description: "Too much", quantity: 1, unitPriceMinor: 50001, incomeAccountId: f.salesAccountId }],
    });

    expect(response.status).toBe(422);
    expect(response.body.title).toBe("CREDIT_NOTE_EXCEEDS_BALANCE");
  });
});

describe("pro-formas", () => {
  it("get a PF number but no journal, and convert once into a draft invoice", async () => {
    const f = await makeFixture();
    const draft = await createDraft(draftBody(f, { kind: "PROFORMA", receivableAccountId: undefined }));

    const issued = await post(`/${draft.body.id}/issue`);
    const noAccount = await post(`/${draft.body.id}/convert`, { clientUuid: randomUUID() });
    const converted = await post(`/${draft.body.id}/convert`, { clientUuid: randomUUID(), receivableAccountId: f.arAccountId });
    const twice = await post(`/${draft.body.id}/convert`, { clientUuid: randomUUID(), receivableAccountId: f.arAccountId });
    const payment = await post(`/${draft.body.id}/payments`, {
      clientUuid: randomUUID(),
      amountMinor: 100,
      date: today,
      receivedAccountId: f.cashAccountId,
    });

    expect(issued.status).toBe(200);
    expect(issued.body.number).toMatch(/^PF-\d{6,}$/);
    expect(issued.body.journal_id).toBeNull();
    expect(noAccount.status).toBe(422);
    expect(converted.status).toBe(201);
    expect(converted.body).toMatchObject({ kind: "INVOICE", status: "DRAFT", proforma_id: draft.body.id, total_minor: "50000" });
    expect(twice.status).toBe(409);
    expect(payment.status).toBe(422);
  });
});

describe("GET /api/v1/invoices", () => {
  it("pages newest first with next_cursor / has_more", async () => {
    const f = await makeFixture();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await createDraft(draftBody(f))).body.id);
    }

    const first = await request(app).get(`/api/v1/invoices?customer_id=${f.customerId}&limit=2`).set(await auth());
    const second = await request(app)
      .get(`/api/v1/invoices?customer_id=${f.customerId}&limit=2&cursor=${first.body.next_cursor}`)
      .set(await auth());
    const bad = await request(app).get(`/api/v1/invoices?cursor=nonsense`).set(await auth());

    expect(first.status).toBe(200);
    expect(first.body.data.map((i: { id: string }) => i.id)).toEqual([ids[2], ids[1]]);
    expect(first.body.has_more).toBe(true);
    expect(first.body.data[0].customer_name).toMatch(/^Invoice Customer/);
    expect(first.body.data[0].lines).toBeUndefined();
    expect(second.body).toMatchObject({ has_more: false, next_cursor: null });
    expect(second.body.data.map((i: { id: string }) => i.id)).toEqual([ids[0]]);
    expect(bad.status).toBe(400);
  });
});

/** Scripted stand-in for Daraja (see payments.test.ts). */
class FakeDaraja implements DarajaClient {
  readonly callbackBaseUrl = "https://staging.example.test";
  pushes: StkPushRequest[] = [];
  queryResult: StkQueryResult = { state: "complete", resultCode: "0", resultDesc: "Processed successfully" };

  async stkPush(req: StkPushRequest) {
    this.pushes.push(req);
    return { merchantRequestId: `mr-${randomUUID()}`, checkoutRequestId: `ws_CO_${randomUUID()}` };
  }

  async stkQuery() {
    return this.queryResult;
  }
}

describe("M-Pesa collection against an invoice", () => {
  let daraja: FakeDaraja;
  beforeEach(() => {
    daraja = new FakeDaraja();
    setDarajaClientForTesting(daraja);
  });

  async function stkPush(body: object) {
    return request(app).post("/api/v1/payments/mpesa/stk-push").set(await auth()).send(body);
  }

  async function succeed(checkoutRequestId: string, shillings: number) {
    const path = daraja.pushes.at(-1)!.callbackUrl.replace(daraja.callbackBaseUrl, "");
    const date = Number(today.replaceAll("-", "") + "101500");
    return request(app)
      .post(path)
      .send({
        Body: {
          stkCallback: {
            MerchantRequestID: "mr",
            CheckoutRequestID: checkoutRequestId,
            ResultCode: 0,
            ResultDesc: "The service request is processed successfully.",
            CallbackMetadata: {
              Item: [
                { Name: "Amount", Value: shillings },
                { Name: "MpesaReceiptNumber", Value: `TIF${randomUUID().slice(0, 7).toUpperCase()}` },
                { Name: "TransactionDate", Value: date },
                { Name: "PhoneNumber", Value: 254712345678 },
              ],
            },
          },
        },
      });
  }

  it("uses the invoice's receivable account and number, and applies the payment when it succeeds", async () => {
    const f = await makeFixture();
    const invoice = await issuedInvoice(f);

    const pushed = await stkPush({
      clientUuid: randomUUID(),
      phone: "0712345678",
      currency: "KES",
      amountMinor: 50000,
      receivedAccountId: f.mpesaAccountId,
      invoiceId: invoice.id,
    });
    expect(pushed.status).toBe(202);
    expect(pushed.body).toMatchObject({ invoice_id: invoice.id, credit_account_id: f.arAccountId, customer_id: f.customerId });
    expect(daraja.pushes[0]!.accountReference).toBe(invoice.number);

    const callback = await succeed(pushed.body.checkout_request_id, 500);
    const after = await get(invoice.id);
    const payment = await request(app).get(`/api/v1/payments/${pushed.body.id}`).set(await auth());

    expect(callback.status).toBe(200);
    expect(after.body).toMatchObject({ status: "PAID", balance_due_minor: "0" });
    expect(after.body.allocations[0]).toMatchObject({ method: "MPESA", payment_id: pushed.body.id, amount_minor: "50000" });
    expect(payment.body).toMatchObject({ status: "SUCCEEDED", journal_id: after.body.allocations[0].journal_id, posting_error: null });
  });

  it("keeps money beyond the balance as unapplied customer credit", async () => {
    const f = await makeFixture();
    const invoice = await issuedInvoice(f);
    const pushed = await stkPush({
      clientUuid: randomUUID(),
      phone: "0712345678",
      currency: "KES",
      amountMinor: 30000,
      receivedAccountId: f.mpesaAccountId,
      invoiceId: invoice.id,
    });
    // Meanwhile the customer pays most of it in cash.
    await post(`/${invoice.id}/payments`, { clientUuid: randomUUID(), amountMinor: 40000, date: today, receivedAccountId: f.cashAccountId });

    await succeed(pushed.body.checkout_request_id, 300);
    const after = await get(invoice.id);

    expect(after.body.status).toBe("PAID");
    expect(after.body.allocations[1]).toMatchObject({ amount_minor: "10000", unapplied_minor: "20000" });
  });

  it("rejects an amount above the balance, or invoiceId with creditAccountId, before prompting", async () => {
    const f = await makeFixture();
    const invoice = await issuedInvoice(f);
    const body = { clientUuid: randomUUID(), phone: "0712345678", currency: "KES", invoiceId: invoice.id };

    const tooMuch = await stkPush({ ...body, amountMinor: 50100 });
    const both = await stkPush({ ...body, amountMinor: 100, creditAccountId: f.salesAccountId });

    expect(tooMuch.status).toBe(422);
    expect(both.status).toBe(400);
    expect(daraja.pushes).toHaveLength(0);
  });
});
