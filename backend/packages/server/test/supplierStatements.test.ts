/**
 * Supplier statements: GET /suppliers/{id}/statement and /statement/pdf --
 * the supplier ledger and payables aging for a period, read on request
 * (nothing stored or numbered). Also what the PDF says
 * (buildSupplierStatementPdfModel), tested as plain strings.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@jibuks/db";
import { createApp } from "../src/app.js";
import { listen } from "./testServer.js";
import { todayInNairobi } from "../src/modules/periods/service.js";
import { buildSupplierStatementPdfModel, describeSupplierTransaction } from "../src/modules/supplierStatements/pdf.js";
import type { SupplierStatement } from "../src/modules/supplierStatements/service.js";
import type { SupplierTransaction } from "../src/modules/supplierLedger/service.js";
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

async function post(path: string, body: object) {
  const response = await request(app).post(`/api/v1${path}`).set(await auth()).send(body);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  return response.body;
}

async function get(path: string) {
  return request(app).get(`/api/v1${path}`).set(await auth());
}

/** A supplier with a bill of 50,000.00, a cheque payment of 20,000.00 against it, and a 3,000.00 cash purchase. */
async function seedSupplier() {
  const account = async (type: string) =>
    (await post("/accounts", { code: randomUUID().slice(0, 8), name: `Statement ${type}`, type })).id as string;
  const [ap, expense, bank] = [await account("LIABILITY"), await account("EXPENSE"), await account("ASSET")];
  const supplier = await post("/suppliers", { name: `Statement Supplier ${randomUUID().slice(0, 8)}` });
  const bill = await post("/supplier-bills", {
    clientUuid: randomUUID(),
    supplierId: supplier.id,
    payableAccountId: ap,
    billDate: today,
    dueDate: addDays(today, 30),
    lines: [{ description: "Maize", quantity: 1, unitPriceMinor: 5000000, expenseAccountId: expense }],
    post: true,
  });
  const payment = await post("/supplier-payments", {
    clientUuid: randomUUID(),
    supplierId: supplier.id,
    amountMinor: 2000000,
    date: today,
    method: "CHEQUE",
    paidFromAccountId: bank,
    reference: "004512",
  });
  const purchase = await post("/cash-purchases", {
    clientUuid: randomUUID(),
    supplierId: supplier.id,
    payableAccountId: ap,
    paidFromAccountId: bank,
    lines: [{ accountId: expense, amountMinor: 300000 }],
  });
  return { supplier, bill, payment, purchase };
}

describe("GET /api/v1/suppliers/{id}/statement", () => {
  it("lists the period's transactions with totals, closing balance and aging", async () => {
    const { supplier, bill, payment, purchase } = await seedSupplier();

    const response = await get(`/suppliers/${supplier.id}/statement?from=${today}&to=${today}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      supplier_id: supplier.id,
      supplier_code: supplier.code,
      currency: "KES",
      period_from: today,
      period_to: today,
      opening_balance_minor: "0",
      total_credit_minor: "5300000",
      total_debit_minor: "2300000",
      closing_balance_minor: "3000000",
    });
    expect(response.body.transactions.map((t: { type: string; document_id: string }) => [t.type, t.document_id])).toEqual([
      ["BILL", bill.id],
      ["PAYMENT", payment.id],
      ["CASH_PURCHASE", purchase.id],
    ]);
    expect(response.body.aging).toMatchObject({ current_minor: "3000000", not_billed_minor: "0", balance_minor: "3000000" });
    expect((await get(`/suppliers/${supplier.id}`)).body.balance_minor).toBe("3000000");
  });

  it("brings everything before the period forward as the opening balance", async () => {
    const { supplier } = await seedSupplier();
    const tomorrow = addDays(today, 1);

    const response = await get(`/suppliers/${supplier.id}/statement?from=${tomorrow}&to=${tomorrow}`);

    expect(response.body).toMatchObject({ opening_balance_minor: "3000000", closing_balance_minor: "3000000", transactions: [] });
  });

  it("defaults to the month to date, and refuses from after to or an unknown supplier", async () => {
    const { supplier } = await seedSupplier();

    const byDefault = await get(`/suppliers/${supplier.id}/statement`);
    const backwards = await get(`/suppliers/${supplier.id}/statement?from=${today}&to=${addDays(today, -1)}`);
    const fromAfterToday = await get(`/suppliers/${supplier.id}/statement?from=${addDays(today, 1)}`);

    expect(byDefault.body).toMatchObject({ period_from: `${today.slice(0, 8)}01`, period_to: today });
    expect(backwards.status).toBe(400);
    expect(fromAfterToday.status).toBe(400);
    expect((await get(`/suppliers/${randomUUID()}/statement`)).status).toBe(404);
  });
});

describe("GET /api/v1/suppliers/{id}/statement/pdf", () => {
  it("returns a PDF named after the supplier's code and the statement date", async () => {
    const { supplier } = await seedSupplier();

    const response = await request(app)
      .get(`/api/v1/suppliers/${supplier.id}/statement/pdf?to=${today}`)
      .set(await auth())
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["content-disposition"]).toBe(`inline; filename="Statement-${supplier.code}-${today}.pdf"`);
    expect((response.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
  });
});

function row(overrides: Partial<SupplierTransaction>): SupplierTransaction {
  return {
    journal_id: "j",
    journal_number: null,
    date: "2026-11-10",
    type: "JOURNAL",
    document_id: null,
    document_kind: null,
    document_number: null,
    debited_bill_id: null,
    debited_bill_number: null,
    payment_method: null,
    reference: null,
    description: "Manual adjustment",
    paid_bills: [],
    unapplied_minor: null,
    credit_minor: "0",
    debit_minor: "0",
    balance_minor: "0",
    ...overrides,
  };
}

describe("buildSupplierStatementPdfModel", () => {
  it("describes each kind of row", () => {
    expect(describeSupplierTransaction(row({ type: "BILL", document_kind: "BILL", document_number: "BILL-000031" }))).toBe("Bill BILL-000031");
    expect(
      describeSupplierTransaction(
        row({ type: "PAYMENT", document_kind: "SUPPLIER_PAYMENT", document_number: "SP-000017", payment_method: "CHEQUE", reference: "004512",
          paid_bills: [
            { bill_id: "a", bill_number: "BILL-000031", supplier_reference: null, amount_minor: "1" },
            { bill_id: "b", bill_number: "BILL-000034", supplier_reference: null, amount_minor: "1" },
          ] }),
      ),
    ).toBe("Payment SP-000017 (Cheque 004512) - BILL-000031, BILL-000034");
    expect(describeSupplierTransaction(row({ type: "DEBIT_NOTE", document_number: "DN-000004", debited_bill_number: "BILL-000031" }))).toBe(
      "Debit note DN-000004 - BILL-000031",
    );
    expect(describeSupplierTransaction(row({ type: "DEBIT_NOTE", document_number: "DN-000005" }))).toBe("Debit note DN-000005");
    expect(describeSupplierTransaction(row({ type: "CASH_PURCHASE", document_number: "PUR-000002" }))).toBe("Cash purchase PUR-000002 (paid)");
    expect(describeSupplierTransaction(row({ type: "REFUND", document_number: "SRF-000001", payment_method: "MPESA", reference: "QK12" }))).toBe(
      "Refund received SRF-000001 (M-Pesa QK12)",
    );
    expect(describeSupplierTransaction(row({ type: "OPENING_BALANCE" }))).toBe("Opening balance");
    expect(describeSupplierTransaction(row({}))).toBe("Manual adjustment");
  });

  it("puts bills under BILLS and payments under PAYMENTS, and shows a credit balance as supplier credit", () => {
    const statement: SupplierStatement = {
      supplier_id: "s",
      supplier_code: "SUP-0007",
      supplier_name: "Unga Millers Ltd",
      currency: "KES",
      period_from: "2026-11-01",
      period_to: "2026-11-30",
      opening_balance_minor: "100000",
      total_credit_minor: "500000",
      total_debit_minor: "700000",
      closing_balance_minor: "-100000",
      transactions: [
        row({ type: "BILL", document_number: "BILL-000031", credit_minor: "500000", balance_minor: "600000" }),
        row({ type: "PAYMENT", document_kind: "SUPPLIER_PAYMENT", document_number: "SP-000017", payment_method: "BANK", debit_minor: "700000", balance_minor: "-100000" }),
      ],
      aging: { current_minor: "0", days_1_30_minor: "0", days_31_60_minor: "0", days_61_90_minor: "0", days_over_90_minor: "0", not_billed_minor: "-100000", balance_minor: "-100000" },
    };

    const model = buildSupplierStatementPdfModel({
      statement,
      business: { name: "Mama Mboga Traders", taxIdentifier: "P051234567X" },
      supplier: { name: "Unga Millers Ltd", taxIdentifier: null, phone: "+254700000000" },
    });

    expect(model).toMatchObject({ title: "SUPPLIER STATEMENT", number: "SUP-0007", partyHeading: "SUPPLIER", columns: ["BILLS", "PAYMENTS"] });
    expect(model.rows[0]).toMatchObject({ details: "Balance brought forward", balance: "KES 1,000.00" });
    expect(model.rows[1]).toMatchObject({ details: "Bill BILL-000031", charges: "KES 5,000.00", payments: "" });
    expect(model.rows[2]).toMatchObject({ details: "Payment SP-000017 (Bank)", charges: "", payments: "KES 7,000.00" });
    expect(model.highlight).toEqual(["Supplier credit", "KES 1,000.00"]);
    expect(model.aging.at(-1)).toEqual(["Not billed", "KES -1,000.00"]);
    expect(model.customer).toEqual(["Unga Millers Ltd", "Tel: +254700000000"]);
    expect(model.filename).toBe("Statement-SUP-0007-2026-11-30.pdf");
  });
});
