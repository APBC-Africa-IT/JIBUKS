/**
 * Cheque payments: cheques as numbered documents (CHQ-000001), posted and
 * PAID when written -- the Write Cheque screen.
 *
 *   Dr line accounts (net) / Dr input VAT / Cr bank (total)
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

async function auth() {
  return { Authorization: await authHeader() };
}

async function post(path: string, body: object) {
  return request(app).post(`/api/v1${path}`).set(await auth()).send(body);
}

interface Fixture {
  bank: string;
  rent: string;
  stock: string;
  vat: string;
  supplierId: string;
  supplierName: string;
}

async function makeFixture(): Promise<Fixture> {
  const account = async (name: string, type: string) => {
    const response = await post("/accounts", { code: randomUUID().slice(0, 8), name, type });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.id as string;
  };
  const supplierName = `Cheque Supplier ${randomUUID().slice(0, 8)}`;
  const supplier = await post("/suppliers", { name: supplierName });
  return {
    bank: await account("Bank Test", "ASSET"),
    rent: await account("Rent Test", "EXPENSE"),
    stock: await account("Inventory Test", "ASSET"),
    vat: await account("Input VAT Test", "ASSET"),
    supplierId: supplier.body.id as string,
    supplierName,
  };
}

function chequeBody(f: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    clientUuid: randomUUID(),
    bankAccountId: f.bank,
    chequeNumber: randomUUID().slice(0, 6),
    lines: [{ accountId: f.rent, amountMinor: 3000000, description: "October rent" }],
    ...overrides,
  };
}

async function journalLines(journalId: string) {
  return withTenant(TEST_TENANT_ID, async (client) => {
    const result = await client.query<{ account_id: string; debit_minor: string; credit_minor: string; supplier_id: string | null }>(
      `SELECT account_id, debit_minor, credit_minor, supplier_id FROM journal_lines WHERE journal_id = $1`,
      [journalId],
    );
    return result.rows;
  });
}

describe("POST /api/v1/cheque-payments", () => {
  it("writes the design's cheque: rent with 16% VAT on top, payee, cheque no -- numbered, posted and PAID", async () => {
    const f = await makeFixture();
    const response = await post(
      "/cheque-payments",
      chequeBody(f, {
        supplierId: f.supplierId,
        taxMode: "EXCLUSIVE",
        memo: "Landlord",
        lines: [{ accountId: f.rent, amountMinor: 3000000, description: "October rent", taxRateBps: 1600, taxAccountId: f.vat }],
      }),
    );

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const cheque = response.body;
    expect(cheque.number).toMatch(/^CHQ-\d{6,}$/);
    expect(cheque).toMatchObject({
      status: "PAID",
      supplier_id: f.supplierId,
      supplier_name: f.supplierName,
      date: today,
      bank_account_id: f.bank,
      subtotal_minor: "3000000",
      tax_minor: "480000",
      total_minor: "3480000",
      memo: "Landlord",
    });
    expect(cheque.lines[0]).toMatchObject({
      account_id: f.rent,
      description: "October rent",
      quantity: "1.000",
      amount_minor: "3000000",
    });

    const lines = await journalLines(cheque.journal_id);
    const amount = (account: string, side: "debit_minor" | "credit_minor") =>
      lines.filter((l) => l.account_id === account).reduce((sum, l) => sum + Number(l[side]), 0);
    expect(amount(f.rent, "debit_minor")).toBe(3000000);
    expect(amount(f.vat, "debit_minor")).toBe(480000);
    expect(amount(f.bank, "credit_minor")).toBe(3480000);
    expect(lines.every((l) => l.supplier_id === null)).toBe(true);

    const supplier = await request(app).get(`/api/v1/suppliers/${f.supplierId}`).set(await auth());
    expect(supplier.body.balance_minor).toBe("0");
  });

  it("debits an INVENTORY item's inventory account on the Stock Purchase tab", async () => {
    const f = await makeFixture();
    const maize = await post("/items", {
      type: "INVENTORY",
      name: `Maize ${randomUUID().slice(0, 8)}`,
      rateMinor: 300000,
      inventoryAccountId: f.stock,
    });
    const response = await post("/cheque-payments", chequeBody(f, { lines: [{ itemId: maize.body.id, quantity: 3 }] }));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.lines[0]).toMatchObject({ item_id: maize.body.id, account_id: f.stock, total_minor: "900000" });
  });

  it("refuses the same cheque number twice on one bank account, posting nothing the second time", async () => {
    const f = await makeFixture();
    const body = chequeBody(f);
    expect((await post("/cheque-payments", body)).status).toBe(201);
    const again = await post("/cheque-payments", { ...body, clientUuid: randomUUID() });
    expect(again.status).toBe(409);

    const journals = await withTenant(TEST_TENANT_ID, async (client) => {
      const result = await client.query(`SELECT 1 FROM journals WHERE reference = $1`, [body.chequeNumber]);
      return result.rowCount;
    });
    expect(journals).toBe(1);
  });

  it("422s a line with no account when its item has none either", async () => {
    const f = await makeFixture();
    const bare = await post("/items", { type: "SERVICE", name: `Bare ${randomUUID().slice(0, 8)}`, rateMinor: 100 });
    const response = await post("/cheque-payments", chequeBody(f, { lines: [{ itemId: bare.body.id }] }));
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toContain("accountId");
  });

  it("400s a line with neither amount nor item, or with both amount and unit price", async () => {
    const f = await makeFixture();
    expect((await post("/cheque-payments", chequeBody(f, { lines: [{ accountId: f.rent }] }))).status).toBe(400);
    expect(
      (await post("/cheque-payments", chequeBody(f, { lines: [{ accountId: f.rent, amountMinor: 100, unitPriceMinor: 100 }] }))).status,
    ).toBe(400);
  });
});

describe("GET /api/v1/cheque-payments", () => {
  it("returns a cheque by id, lists by payee, and keeps cheques out of /supplier-bills", async () => {
    const f = await makeFixture();
    const cheque = (await post("/cheque-payments", chequeBody(f, { supplierId: f.supplierId }))).body;

    const one = await request(app).get(`/api/v1/cheque-payments/${cheque.id}`).set(await auth());
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ id: cheque.id, cheque_number: cheque.cheque_number });

    const listed = await request(app).get(`/api/v1/cheque-payments?supplier_id=${f.supplierId}`).set(await auth());
    expect(listed.body.data.map((c: { id: string }) => c.id)).toEqual([cheque.id]);

    expect((await request(app).get(`/api/v1/supplier-bills/${cheque.id}`).set(await auth())).status).toBe(404);
    const bills = await request(app).get(`/api/v1/supplier-bills?supplier_id=${f.supplierId}`).set(await auth());
    expect(bills.body.data).toEqual([]);
  });
});
