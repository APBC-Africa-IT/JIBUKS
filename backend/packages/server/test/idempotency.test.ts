/**
 * HTTP-level tests for the Idempotency-Key header (SRS Section 9.1, C-08).
 *
 * Exercised through the guided Cash Sale endpoint -- the header is handled
 * by middleware shared by every tenant route (requireRealIdentity), so one
 * posting endpoint is representative -- plus accounts, to prove a key
 * cannot be reused across endpoints.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@jibuks/db";
import { createApp } from "../src/app.js";
import { authHeader, TEST_TENANT_ID } from "./testAuth.js";

const app = createApp();

afterAll(async () => {
  await closePool();
});

interface Fixture {
  cashAccountId: string;
  salesAccountId: string;
}

async function makeFixture(): Promise<Fixture> {
  await withTenant(TEST_TENANT_ID, async (client) => {
    await client.query(
      `INSERT INTO periods (tenant_id, start_date, end_date) VALUES ($1, '2026-09-01', '2026-09-30')`,
      [TEST_TENANT_ID],
    );
  });

  const cash = await request(app)
    .post("/api/v1/accounts")
    .set("Authorization", await authHeader())
    .send({ code: randomUUID().slice(0, 8), name: "Cash Idem Test", type: "ASSET" });
  const sales = await request(app)
    .post("/api/v1/accounts")
    .set("Authorization", await authHeader())
    .send({ code: randomUUID().slice(0, 8), name: "Sales Idem Test", type: "INCOME" });

  return { cashAccountId: cash.body.id as string, salesAccountId: sales.body.id as string };
}

function cashSaleBody(fixture: Fixture, clientUuid: string = randomUUID(), amountMinor = 25000) {
  return {
    clientUuid,
    receivedAccountId: fixture.cashAccountId,
    date: "2026-09-15",
    currency: "KES",
    lines: [{ incomeAccountId: fixture.salesAccountId, amountMinor }],
  };
}

async function postCashSale(body: object, key?: string) {
  const req = request(app).post("/api/v1/cash-sales").set("Authorization", await authHeader());
  if (key !== undefined) {
    req.set("Idempotency-Key", key);
  }
  return req.send(body);
}

async function countJournals(clientUuid: string): Promise<number> {
  return withTenant(TEST_TENANT_ID, async (client) => {
    const result = await client.query(`SELECT count(*)::int AS n FROM journals WHERE client_uuid = $1`, [clientUuid]);
    return result.rows[0].n as number;
  });
}

describe("Idempotency-Key header", () => {
  it("replays the original 201 response on a repeat, without posting a second journal", async () => {
    const fixture = await makeFixture();
    const key = randomUUID();
    const body = cashSaleBody(fixture);

    const first = await postCashSale(body, key);
    const second = await postCashSale(body, key);

    expect(first.status).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(second.status).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(await countJournals(body.clientUuid)).toBe(1);
  });

  it("treats the same body with keys in a different order as the same request", async () => {
    const fixture = await makeFixture();
    const key = randomUUID();
    const body = cashSaleBody(fixture);
    const reordered = Object.fromEntries(Object.entries(body).reverse());

    const first = await postCashSale(body, key);
    const second = await postCashSale(reordered, key);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
  });

  it("rejects the same key with a different body as 422 IDEMPOTENCY_KEY_REUSED", async () => {
    const fixture = await makeFixture();
    const key = randomUUID();

    const first = await postCashSale(cashSaleBody(fixture), key);
    const second = await postCashSale(cashSaleBody(fixture), key);

    expect(first.status).toBe(201);
    expect(second.status).toBe(422);
    expect(second.body.title).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("rejects the same key reused on a different endpoint as 422 IDEMPOTENCY_KEY_REUSED", async () => {
    const fixture = await makeFixture();
    const key = randomUUID();

    const first = await postCashSale(cashSaleBody(fixture), key);
    const second = await request(app)
      .post("/api/v1/accounts")
      .set("Authorization", await authHeader())
      .set("Idempotency-Key", key)
      .send({ code: randomUUID().slice(0, 8), name: "Other", type: "ASSET" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(422);
    expect(second.body.title).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("does not consume the key when the request fails, so a corrected retry succeeds", async () => {
    const fixture = await makeFixture();
    const key = randomUUID();
    const invalid = { ...cashSaleBody(fixture), lines: [] };

    const failed = await postCashSale(invalid, key);
    const retried = await postCashSale(cashSaleBody(fixture), key);

    expect(failed.status).toBe(400);
    expect(failed.headers["idempotent-replayed"]).toBeUndefined();
    expect(retried.status).toBe(201);
    expect(retried.headers["idempotent-replayed"]).toBeUndefined();
  });

  it("returns 409 IDEMPOTENCY_REQUEST_IN_PROGRESS while the original request is still running", async () => {
    const fixture = await makeFixture();
    const key = randomUUID();
    await withTenant(TEST_TENANT_ID, async (client) => {
      await client.query(
        `INSERT INTO idempotency_keys (tenant_id, key, request_hash, status) VALUES ($1, $2, 'in-flight', 'IN_PROGRESS')`,
        [TEST_TENANT_ID, key],
      );
    });

    const response = await postCashSale(cashSaleBody(fixture), key);

    expect(response.status).toBe(409);
    expect(response.body.title).toBe("IDEMPOTENCY_REQUEST_IN_PROGRESS");
  });

  it("rejects a malformed key with 400 IDEMPOTENCY_KEY_INVALID", async () => {
    const fixture = await makeFixture();

    const tooLong = await postCashSale(cashSaleBody(fixture), "k".repeat(256));
    const withSpace = await postCashSale(cashSaleBody(fixture), "has space");

    expect(tooLong.status).toBe(400);
    expect(tooLong.body.title).toBe("IDEMPOTENCY_KEY_INVALID");
    expect(withSpace.status).toBe(400);
    expect(withSpace.body.title).toBe("IDEMPOTENCY_KEY_INVALID");
  });

  it("leaves requests without the header unchanged: a repeated clientUuid is still 409 DUPLICATE_VALUE", async () => {
    const fixture = await makeFixture();
    const body = cashSaleBody(fixture);

    const first = await postCashSale(body);
    const second = await postCashSale(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.title).toBe("DUPLICATE_VALUE");
  });
});
