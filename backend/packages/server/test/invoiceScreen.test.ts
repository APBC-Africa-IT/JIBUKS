/**
 * Create Invoice screen fields: PO number, ship-to, shipping date, the
 * invoice's own terms, memo -- and Save issuing in one call (issue: true).
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@jibuks/db";
import { createApp } from "../src/app.js";
import { listen } from "./testServer.js";
import { addDays } from "../src/modules/invoices/documents.js";
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

async function post(path: string, body: object) {
  return request(app).post(`/api/v1${path}`).set(await auth()).send(body);
}

async function patch(path: string, body: object) {
  return request(app).patch(`/api/v1${path}`).set(await auth()).send(body);
}

interface Fixture {
  income: string;
  receivable: string;
  customerId: string;
}

async function makeFixture(customer: Record<string, unknown> = {}): Promise<Fixture> {
  const account = async (name: string, type: string) => {
    const response = await post("/accounts", { code: randomUUID().slice(0, 8), name, type });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.id as string;
  };
  const created = await post("/customers", { name: `Screen Customer ${randomUUID().slice(0, 8)}`, ...customer });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return {
    income: await account("Sales Test", "INCOME"),
    receivable: await account("AR Test", "ASSET"),
    customerId: created.body.id as string,
  };
}

function body(f: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    clientUuid: randomUUID(),
    customerId: f.customerId,
    receivableAccountId: f.receivable,
    issueDate: today,
    lines: [{ description: "Maize flour 2kg", quantity: 2, unitPriceMinor: 25000, incomeAccountId: f.income }],
    ...overrides,
  };
}

describe("Create Invoice fields", () => {
  it("stores PO number, ship-to, shipping date, memo and the invoice's own terms, with the due date from them", async () => {
    const f = await makeFixture({ paymentTermsDays: 30 });
    const response = await post(
      "/invoices",
      body(f, {
        poNumber: "PO-778",
        shipTo: "Stall 12, Gikomba Market, Nairobi",
        shippingDate: addDays(today, 2),
        paymentTermsDays: 14,
        memo: "Called ahead",
        notes: "Thank you for your business",
      }),
    );

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({
      po_number: "PO-778",
      ship_to: "Stall 12, Gikomba Market, Nairobi",
      shipping_date: addDays(today, 2),
      payment_terms_days: 14,
      due_date: addDays(today, 14),
      memo: "Called ahead",
      notes: "Thank you for your business",
    });
    expect(response.body.payment_method).toBeUndefined();
  });

  it("takes the customer's terms when the invoice names none", async () => {
    const f = await makeFixture({ paymentTermsDays: 30 });
    const response = await post("/invoices", body(f));
    expect(response.body).toMatchObject({ payment_terms_days: 30, due_date: addDays(today, 30) });
  });

  it("recomputes the due date when terms change on a draft, and null goes back to the customer's", async () => {
    const f = await makeFixture({ paymentTermsDays: 30 });
    const draft = (await post("/invoices", body(f))).body;

    const seven = await patch(`/invoices/${draft.id}`, { paymentTermsDays: 7 });
    expect(seven.status, JSON.stringify(seven.body)).toBe(200);
    expect(seven.body).toMatchObject({ payment_terms_days: 7, due_date: addDays(today, 7) });

    const unrelated = await patch(`/invoices/${draft.id}`, { poNumber: "PO-1" });
    expect(unrelated.body).toMatchObject({ payment_terms_days: 7, due_date: addDays(today, 7), po_number: "PO-1" });

    const reset = await patch(`/invoices/${draft.id}`, { paymentTermsDays: null, poNumber: null });
    expect(reset.body).toMatchObject({ payment_terms_days: 30, due_date: addDays(today, 30), po_number: null });
  });

  it("copies the fields when a pro-forma is converted", async () => {
    const f = await makeFixture();
    const proforma = await post("/invoices", body(f, { kind: "PROFORMA", poNumber: "PO-9", shipTo: "Thika Road", paymentTermsDays: 10 }));
    const converted = await post(`/invoices/${proforma.body.id}/convert`, { clientUuid: randomUUID() });
    expect(converted.status, JSON.stringify(converted.body)).toBe(201);
    expect(converted.body).toMatchObject({ po_number: "PO-9", ship_to: "Thika Road", payment_terms_days: 10 });
  });

  it("prints the new fields on the PDF", async () => {
    const f = await makeFixture();
    const invoice = await post("/invoices", body(f, { poNumber: "PO-5", shipTo: "Stall 12\nGikomba", issue: true }));
    const pdf = await request(app).get(`/api/v1/invoices/${invoice.body.id}/pdf`).set(await auth());
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
  });
});

describe("POST /invoices with issue: true", () => {
  it("creates, numbers and posts in one call", async () => {
    const f = await makeFixture();
    const response = await post("/invoices", body(f, { issue: true }));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.status).toBe("ISSUED");
    expect(response.body.number).toMatch(/^INV-\d{6,}$/);
    expect(response.body.journal_id).toBeTruthy();
  });

  it("leaves nothing behind when issuing is refused, so the same clientUuid can be retried", async () => {
    const f = await makeFixture({ creditLimitMinor: 10000 });
    const first = body(f, { issue: true });

    const refused = await post("/invoices", first);
    expect(refused.status).toBe(422);
    expect(refused.body.title).toBe("CREDIT_LIMIT_EXCEEDED");
    const list = await request(app).get(`/api/v1/invoices?customer_id=${f.customerId}`).set(await auth());
    expect(list.body.data).toEqual([]);

    const retried = await post("/invoices", { ...first, overrideCreditLimit: true });
    expect(retried.status, JSON.stringify(retried.body)).toBe(201);
    expect(retried.body).toMatchObject({ status: "ISSUED", credit_limit_overridden: true });
  });
});
