/**
 * Bill lines entered as an amount (the Bill screen's Amount column) rather
 * than a unit price: the amount stays exact even when it doesn't divide
 * by the quantity.
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
  stock: string;
  vat: string;
  payable: string;
  supplierId: string;
}

async function makeFixture(): Promise<Fixture> {
  const account = async (name: string, type: string) => {
    const response = await post("/accounts", { code: randomUUID().slice(0, 8), name, type });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.id as string;
  };
  const supplier = await post("/suppliers", { name: `Amount Supplier ${randomUUID().slice(0, 8)}` });
  return {
    stock: await account("Inventory Test", "ASSET"),
    vat: await account("Input VAT Test", "ASSET"),
    payable: await account("AP Test", "LIABILITY"),
    supplierId: supplier.body.id as string,
  };
}

function billBody(f: Fixture, taxMode: string, lines: object[]) {
  return {
    clientUuid: randomUUID(),
    supplierId: f.supplierId,
    payableAccountId: f.payable,
    billDate: today,
    taxMode,
    lines,
  };
}

describe("bill lines with amountMinor", () => {
  it("keep 3 for 1,000.00 exact, with VAT on top, through posting", async () => {
    const f = await makeFixture();
    const created = await post(
      "/supplier-bills",
      billBody(f, "EXCLUSIVE", [
        { description: "Maize 90kg bags", quantity: 3, amountMinor: 100000, expenseAccountId: f.stock, taxRateBps: 1600, taxAccountId: f.vat },
      ]),
    );

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.lines[0]).toMatchObject({
      quantity: "3.000",
      unit_price_minor: "33333",
      amount_minor: "100000",
      net_minor: "100000",
      tax_minor: "16000",
      total_minor: "116000",
    });
    expect(created.body.total_minor).toBe("116000");

    const posted = await post(`/supplier-bills/${created.body.id}/post`, {});
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const debit = await withTenant(TEST_TENANT_ID, async (client) => {
      const result = await client.query<{ debit_minor: string }>(
        `SELECT debit_minor FROM journal_lines WHERE journal_id = $1 AND account_id = $2`,
        [posted.body.journal_id, f.stock],
      );
      return result.rows[0]!.debit_minor;
    });
    expect(debit).toBe("100000");
  });

  it("take the amount as VAT-inclusive under INCLUSIVE", async () => {
    const f = await makeFixture();
    const created = await post(
      "/supplier-bills",
      billBody(f, "INCLUSIVE", [
        { description: "Sugar", quantity: 3, amountMinor: 30000, expenseAccountId: f.stock, taxRateBps: 1600, taxAccountId: f.vat },
      ]),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ subtotal_minor: "25862", tax_minor: "4138", total_minor: "30000" });
  });

  it("stay exact when the draft is edited without touching its lines", async () => {
    const f = await makeFixture();
    const created = await post(
      "/supplier-bills",
      billBody(f, "NONE", [{ description: "Bags", quantity: 3, amountMinor: 100000, expenseAccountId: f.stock }]),
    );
    const edited = await request(app)
      .patch(`/api/v1/supplier-bills/${created.body.id}`)
      .set(await auth())
      .send({ supplierReference: `INV-${randomUUID().slice(0, 6)}` });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.total_minor).toBe("100000");
    expect(edited.body.lines[0].amount_minor).toBe("100000");
  });

  it("leave amount_minor null for a line priced per unit", async () => {
    const f = await makeFixture();
    const created = await post(
      "/supplier-bills",
      billBody(f, "NONE", [{ description: "Bags", quantity: 3, unitPriceMinor: 33333, expenseAccountId: f.stock }]),
    );
    expect(created.body.lines[0]).toMatchObject({ amount_minor: null, total_minor: "99999" });
  });

  it("400 with both unitPriceMinor and amountMinor, or neither", async () => {
    const f = await makeFixture();
    const both = await post(
      "/supplier-bills",
      billBody(f, "NONE", [{ description: "Bags", quantity: 3, unitPriceMinor: 100, amountMinor: 300, expenseAccountId: f.stock }]),
    );
    expect(both.status).toBe(400);
    const neither = await post("/supplier-bills", billBody(f, "NONE", [{ description: "Bags", quantity: 3, expenseAccountId: f.stock }]));
    expect(neither.status).toBe(400);
  });
});
