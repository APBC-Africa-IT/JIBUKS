/**
 * Items: the product/service catalogue (Add Item screen, Item dropdowns).
 * Names are random per test -- the test tenant is shared and item names
 * are unique among siblings.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@jibuks/db";
import { createApp } from "../src/app.js";
import { listen } from "./testServer.js";
import { authHeader } from "./testAuth.js";

const app = await listen(createApp());

afterAll(async () => {
  await closePool();
});

async function auth() {
  return { Authorization: await authHeader() };
}

async function account(name: string, type: string): Promise<string> {
  const response = await request(app)
    .post("/api/v1/accounts")
    .set(await auth())
    .send({ code: randomUUID().slice(0, 8), name, type });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.id as string;
}

const unique = (name: string) => `${name} ${randomUUID().slice(0, 8)}`;

async function createItem(body: object) {
  return request(app).post("/api/v1/items").set(await auth()).send(body);
}

async function patchItem(id: string, body: object) {
  return request(app).patch(`/api/v1/items/${id}`).set(await auth()).send(body);
}

describe("POST /api/v1/items", () => {
  it("creates a service with the Add Item screen's fields", async () => {
    const income = await account("Service Income Test", "INCOME");
    const name = unique("Haircut");
    const response = await createItem({
      type: "SERVICE",
      name,
      unitOfMeasure: "session",
      rateMinor: 30000,
      incomeAccountId: income,
      description: "Standard cut",
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({
      type: "SERVICE",
      name,
      full_name: name,
      parent_item_id: null,
      unit_of_measure: "session",
      rate_minor: "30000",
      income_account_id: income,
      track_stock: false,
      description: "Standard cut",
      is_active: true,
    });
  });

  it("creates a stock-tracked inventory item with its inventory account, or an inactive one", async () => {
    const stock = await account("Inventory Test", "ASSET");
    const tracked = await createItem({ type: "INVENTORY", name: unique("Maize flour 2kg"), trackStock: true, inventoryAccountId: stock });
    expect(tracked.status, JSON.stringify(tracked.body)).toBe(201);
    expect(tracked.body).toMatchObject({ track_stock: true, inventory_account_id: stock });

    const inactive = await createItem({ type: "NON_INVENTORY", name: unique("Old stock"), isActive: false });
    expect(inactive.body.is_active).toBe(false);
  });

  it("only lets INVENTORY items track stock or have an inventory account", async () => {
    const stock = await account("Inventory Test", "ASSET");
    expect((await createItem({ type: "SERVICE", name: unique("X"), trackStock: true })).status).toBe(400);
    expect((await createItem({ type: "SERVICE", name: unique("X"), inventoryAccountId: stock })).status).toBe(400);
  });

  it("checks each account's type", async () => {
    const expense = await account("Rent Test", "EXPENSE");
    const response = await createItem({ type: "SERVICE", name: unique("X"), incomeAccountId: expense });
    expect(response.status).toBe(422);
    expect(response.body.title).toBe("ACCOUNT_WRONG_TYPE");
  });

  it("refuses a duplicate name under the same parent, ignoring case, but allows it under another", async () => {
    const name = unique("Shave");
    expect((await createItem({ type: "SERVICE", name })).status).toBe(201);
    const duplicate = await createItem({ type: "SERVICE", name: name.toUpperCase() });
    expect(duplicate.status).toBe(409);

    const parent = await createItem({ type: "SERVICE", name: unique("Grooming") });
    const child = await createItem({ type: "SERVICE", name, parentItemId: parent.body.id });
    expect(child.status, JSON.stringify(child.body)).toBe(201);
    expect(child.body.full_name).toBe(`${parent.body.name}: ${name}`);
  });

  it("404s for a parent that doesn't exist", async () => {
    const response = await createItem({ type: "SERVICE", name: unique("X"), parentItemId: randomUUID() });
    expect(response.status).toBe(404);
    expect(response.body.title).toBe("ITEM_NOT_FOUND");
  });
});

describe("GET /api/v1/items", () => {
  it("lists sub-items under their parent, and filters by search, parent, type and active", async () => {
    const tag = randomUUID().slice(0, 8);
    const parent = (await createItem({ type: "SERVICE", name: `Haircut ${tag}` })).body;
    const kids = (await createItem({ type: "SERVICE", name: "Kids", parentItemId: parent.id })).body;
    const goods = (await createItem({ type: "NON_INVENTORY", name: `Comb ${tag}` })).body;
    await request(app).post(`/api/v1/items/${goods.id}/deactivate`).set(await auth());

    const all = await request(app).get(`/api/v1/items?q=${tag}`).set(await auth());
    expect(all.status).toBe(200);
    expect(all.body.data.map((i: { full_name: string }) => i.full_name)).toEqual([
      `Comb ${tag}`,
      `Haircut ${tag}`,
      `Haircut ${tag}: Kids`,
    ]);

    const active = await request(app).get(`/api/v1/items?q=${tag}&active=true`).set(await auth());
    expect(active.body.data.map((i: { id: string }) => i.id)).toEqual([parent.id, kids.id]);

    const children = await request(app).get(`/api/v1/items?parent_item_id=${parent.id}`).set(await auth());
    expect(children.body.data.map((i: { id: string }) => i.id)).toEqual([kids.id]);

    const services = await request(app).get(`/api/v1/items?q=${tag}&type=NON_INVENTORY`).set(await auth());
    expect(services.body.data.map((i: { id: string }) => i.id)).toEqual([goods.id]);
  });

  it("404s an unknown or malformed id", async () => {
    expect((await request(app).get(`/api/v1/items/${randomUUID()}`).set(await auth())).status).toBe(404);
    expect((await request(app).get(`/api/v1/items/not-an-id`).set(await auth())).status).toBe(404);
  });
});

describe("PATCH /api/v1/items/{id}", () => {
  it("changes only what is sent, and null clears", async () => {
    const item = (await createItem({ type: "SERVICE", name: unique("Shave"), rateMinor: 15000, unitOfMeasure: "each" })).body;
    const response = await patchItem(item.id, { rateMinor: 20000, unitOfMeasure: null });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ name: item.name, rate_minor: "20000", unit_of_measure: null });
  });

  it("refuses a change that leaves a non-INVENTORY item tracking stock", async () => {
    const item = (await createItem({ type: "INVENTORY", name: unique("Soap"), trackStock: true })).body;
    const response = await patchItem(item.id, { type: "SERVICE" });
    expect(response.status).toBe(422);
    expect(response.body.title).toBe("ITEM_INVALID");
    expect((await patchItem(item.id, { type: "SERVICE", trackStock: false })).status).toBe(200);
  });

  it("refuses to make an item a sub-item of itself or of its own sub-item", async () => {
    const parent = (await createItem({ type: "SERVICE", name: unique("A") })).body;
    const child = (await createItem({ type: "SERVICE", name: unique("B"), parentItemId: parent.id })).body;
    expect((await patchItem(parent.id, { parentItemId: child.id })).status).toBe(422);
    expect((await patchItem(parent.id, { parentItemId: parent.id })).status).toBe(422);
    expect((await patchItem(child.id, { parentItemId: null })).body.full_name).toBe(child.name);
  });
});

describe("deactivate / reactivate", () => {
  it("toggles is_active", async () => {
    const item = (await createItem({ type: "SERVICE", name: unique("Beard trim") })).body;
    const off = await request(app).post(`/api/v1/items/${item.id}/deactivate`).set(await auth());
    expect(off.body.is_active).toBe(false);
    const on = await request(app).post(`/api/v1/items/${item.id}/reactivate`).set(await auth());
    expect(on.body.is_active).toBe(true);
  });
});
