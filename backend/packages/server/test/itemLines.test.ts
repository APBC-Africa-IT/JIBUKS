/**
 * Picking a catalogue item on a line (invoices, supplier bills, cash
 * sales): what the line leaves out comes from the item, what it states
 * wins, and the line remembers item_id.
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

async function account(name: string, type: string): Promise<string> {
  const response = await post("/accounts", { code: randomUUID().slice(0, 8), name, type });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.id as string;
}

async function item(body: Record<string, unknown>) {
  const response = await post("/items", { name: `Item ${randomUUID().slice(0, 8)}`, ...body });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body as { id: string; name: string; full_name: string };
}

interface Fixture {
  income: string;
  otherIncome: string;
  expense: string;
  inventory: string;
  receivable: string;
  payable: string;
  cash: string;
  customerId: string;
  supplierId: string;
}

async function makeFixture(): Promise<Fixture> {
  const customer = await post("/customers", { name: `Item Customer ${randomUUID().slice(0, 8)}` });
  const supplier = await post("/suppliers", { name: `Item Supplier ${randomUUID().slice(0, 8)}` });
  return {
    income: await account("Service Income Test", "INCOME"),
    otherIncome: await account("Other Income Test", "INCOME"),
    expense: await account("Supplies Expense Test", "EXPENSE"),
    inventory: await account("Inventory Test", "ASSET"),
    receivable: await account("AR Test", "ASSET"),
    payable: await account("AP Test", "LIABILITY"),
    cash: await account("Cash Test", "ASSET"),
    customerId: customer.body.id as string,
    supplierId: supplier.body.id as string,
  };
}

function invoiceBody(f: Fixture, lines: object[]) {
  return { clientUuid: randomUUID(), customerId: f.customerId, receivableAccountId: f.receivable, issueDate: today, lines };
}

describe("invoice lines", () => {
  it("fill price, income account and description from the item, and keep item_id", async () => {
    const f = await makeFixture();
    const haircut = await item({ type: "SERVICE", rateMinor: 30000, incomeAccountId: f.income, description: "Standard cut" });
    const shave = await item({ type: "SERVICE", rateMinor: 15000, incomeAccountId: f.income });

    const response = await post(
      "/invoices",
      invoiceBody(f, [
        { itemId: haircut.id, quantity: 2 },
        { itemId: shave.id, quantity: 1 },
      ]),
    );

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.total_minor).toBe("75000");
    expect(response.body.lines[0]).toMatchObject({
      item_id: haircut.id,
      description: "Standard cut",
      unit_price_minor: "30000",
      income_account_id: f.income,
    });
    // No description on the item: its name stands in.
    expect(response.body.lines[1]).toMatchObject({ item_id: shave.id, description: shave.full_name });
    expect(response.body.lines[0].item_name).toBeUndefined();
  });

  it("lets what the line states win over the item", async () => {
    const f = await makeFixture();
    const haircut = await item({ type: "SERVICE", rateMinor: 30000, incomeAccountId: f.income });
    const response = await post(
      "/invoices",
      invoiceBody(f, [
        { itemId: haircut.id, quantity: 1, unitPriceMinor: 25000, incomeAccountId: f.otherIncome, description: "Discounted" },
      ]),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.lines[0]).toMatchObject({
      unit_price_minor: "25000",
      income_account_id: f.otherIncome,
      description: "Discounted",
    });
  });

  it("422s when neither the line nor the item has an income account or a rate", async () => {
    const f = await makeFixture();
    const bare = await item({ type: "SERVICE" });
    const noAccount = await post("/invoices", invoiceBody(f, [{ itemId: bare.id, quantity: 1, unitPriceMinor: 100 }]));
    expect(noAccount.status).toBe(422);
    expect(noAccount.body.title).toBe("ITEM_INVALID");
    const noRate = await post("/invoices", invoiceBody(f, [{ itemId: bare.id, quantity: 1, incomeAccountId: f.income }]));
    expect(noRate.status).toBe(422);
  });

  it("400s a line with no item that leaves out price, account or description", async () => {
    const f = await makeFixture();
    const response = await post("/invoices", invoiceBody(f, [{ description: "Thing", quantity: 1, incomeAccountId: f.income }]));
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("unitPriceMinor");
  });

  it("refuses an inactive item on a new line, but a draft holding it can still be edited and a pro-forma converted", async () => {
    const f = await makeFixture();
    const haircut = await item({ type: "SERVICE", rateMinor: 30000, incomeAccountId: f.income });
    const draft = await post("/invoices", invoiceBody(f, [{ itemId: haircut.id, quantity: 1 }]));
    const proforma = await post("/invoices", { ...invoiceBody(f, [{ itemId: haircut.id, quantity: 1 }]), kind: "PROFORMA" });
    expect(proforma.status, JSON.stringify(proforma.body)).toBe(201);
    await post(`/items/${haircut.id}/deactivate`, {});

    const fresh = await post("/invoices", invoiceBody(f, [{ itemId: haircut.id, quantity: 1 }]));
    expect(fresh.status).toBe(422);
    expect(fresh.body.title).toBe("ITEM_INVALID");

    const edited = await request(app).patch(`/api/v1/invoices/${draft.body.id}`).set(await auth()).send({ reference: "PO-1" });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.lines[0].item_id).toBe(haircut.id);

    const converted = await post(`/invoices/${proforma.body.id}/convert`, { clientUuid: randomUUID() });
    expect(converted.status, JSON.stringify(converted.body)).toBe(201);
    expect(converted.body.lines[0].item_id).toBe(haircut.id);
  });
});

describe("supplier bill lines", () => {
  it("debit an INVENTORY item's inventory account and other items' expense account", async () => {
    const f = await makeFixture();
    const maize = await item({ type: "INVENTORY", rateMinor: 300000, inventoryAccountId: f.inventory, trackStock: true });
    const gloves = await item({ type: "NON_INVENTORY", rateMinor: 5000, expenseAccountId: f.expense });

    const response = await post("/supplier-bills", {
      clientUuid: randomUUID(),
      supplierId: f.supplierId,
      payableAccountId: f.payable,
      billDate: today,
      lines: [
        { itemId: maize.id, quantity: 4 },
        { itemId: gloves.id, quantity: 10 },
      ],
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.lines[0]).toMatchObject({ item_id: maize.id, expense_account_id: f.inventory, unit_price_minor: "300000" });
    expect(response.body.lines[1]).toMatchObject({ item_id: gloves.id, expense_account_id: f.expense });
    expect(response.body.total_minor).toBe("1250000");
  });
});

describe("cash sale lines", () => {
  it("take the item's name, price and income account", async () => {
    const f = await makeFixture();
    const parent = await item({ type: "SERVICE" });
    const kids = await item({ type: "SERVICE", parentItemId: parent.id, rateMinor: 20000, incomeAccountId: f.income });

    const response = await post("/sales-receipts", {
      clientUuid: randomUUID(),
      paymentMethod: "CASH",
      depositAccountId: f.cash,
      lines: [{ itemId: kids.id, quantity: 1 }, { item: "Hot towel", quantity: 1, unitPriceMinor: 5000, incomeAccountId: f.income }],
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.lines[0]).toMatchObject({
      item_id: kids.id,
      item: kids.full_name,
      description: null,
      unit_price_minor: "20000",
      income_account_id: f.income,
    });
    expect(response.body.lines[1]).toMatchObject({ item_id: null, item: "Hot towel" });
    expect(response.body.total_minor).toBe("25000");
  });

  it("400s a line with neither item nor itemId", async () => {
    const f = await makeFixture();
    const response = await post("/sales-receipts", {
      clientUuid: randomUUID(),
      paymentMethod: "CASH",
      depositAccountId: f.cash,
      lines: [{ quantity: 1, unitPriceMinor: 5000, incomeAccountId: f.income }],
    });
    expect(response.status).toBe(400);
  });
});
