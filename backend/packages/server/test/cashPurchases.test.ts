/**
 * Cash purchases: bought and paid on the spot (PUR-000001), posted and PAID
 * when recorded -- the Suppliers hub's Cash Purchase screen.
 *
 *   Dr line accounts (net) / Dr input VAT / Cr the money account (total),
 *   passing through payables tagged with the supplier when one is named,
 *   so it shows in their history while their balance doesn't move.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@jibuks/db";
import { SYSTEM_ROLES } from "@jibuks/domain";
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

async function get(path: string) {
  return request(app).get(`/api/v1${path}`).set(await auth());
}

interface Fixture {
  cash: string;
  ap: string;
  supplies: string;
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
  const supplierName = `Cash Purchase Supplier ${randomUUID().slice(0, 8)}`;
  const supplier = await post("/suppliers", { name: supplierName });
  return {
    cash: await account("Cash Test", "ASSET"),
    ap: await account("Payables Test", "LIABILITY"),
    supplies: await account("Supplies Test", "EXPENSE"),
    vat: await account("Input VAT Test", "ASSET"),
    supplierId: supplier.body.id as string,
    supplierName,
  };
}

function purchaseBody(f: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    clientUuid: randomUUID(),
    paymentMethod: "CASH",
    paidFromAccountId: f.cash,
    lines: [{ accountId: f.supplies, amountMinor: 250000, description: "Packaging bags" }],
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

describe("POST /api/v1/cash-purchases", () => {
  it("records a purchase from a supplier: numbered, posted and PAID, through their payables", async () => {
    const f = await makeFixture();
    const before = (await get(`/suppliers/${f.supplierId}`)).body.balance_minor;

    const response = await post(
      "/cash-purchases",
      purchaseBody(f, {
        supplierId: f.supplierId,
        payableAccountId: f.ap,
        supplierReference: "RCPT-4471",
        paymentMethod: "MPESA",
        reference: "SKL4X9P2QA",
        taxMode: "EXCLUSIVE",
        memo: "Market day",
        lines: [{ accountId: f.supplies, amountMinor: 250000, description: "Packaging bags", taxRateBps: 1600, taxAccountId: f.vat }],
      }),
    );

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const purchase = response.body;
    expect(purchase.number).toMatch(/^PUR-\d{6,}$/);
    expect(purchase).toMatchObject({
      status: "PAID",
      supplier_id: f.supplierId,
      supplier_name: f.supplierName,
      supplier_reference: "RCPT-4471",
      date: today,
      payment_method: "MPESA",
      paid_from_account_id: f.cash,
      payable_account_id: f.ap,
      subtotal_minor: "250000",
      tax_minor: "40000",
      total_minor: "290000",
      reference: "SKL4X9P2QA",
      memo: "Market day",
    });
    expect(purchase.lines).toEqual([
      expect.objectContaining({ account_id: f.supplies, description: "Packaging bags", net_minor: "250000", tax_minor: "40000" }),
    ]);
    expect(await journalLines(purchase.journal_id)).toEqual(
      expect.arrayContaining([
        { account_id: f.supplies, debit_minor: "250000", credit_minor: "0", supplier_id: null },
        { account_id: f.vat, debit_minor: "40000", credit_minor: "0", supplier_id: null },
        { account_id: f.ap, debit_minor: "0", credit_minor: "290000", supplier_id: f.supplierId },
        { account_id: f.ap, debit_minor: "290000", credit_minor: "0", supplier_id: f.supplierId },
        { account_id: f.cash, debit_minor: "0", credit_minor: "290000", supplier_id: null },
      ]),
    );
    expect((await journalLines(purchase.journal_id)).length).toBe(5);

    const supplier = (await get(`/suppliers/${f.supplierId}`)).body;
    expect(supplier.balance_minor).toBe(before);
    expect(supplier.last_activity).toMatchObject({ type: "CASH_PURCHASE", document_number: purchase.number });
    const ledger = (await get(`/suppliers/${f.supplierId}/transactions`)).body.data;
    expect(ledger.at(-1)).toMatchObject({
      type: "CASH_PURCHASE",
      document_kind: "CASH_PURCHASE",
      document_id: purchase.id,
      credit_minor: "290000",
      debit_minor: "290000",
    });
  });

  it("records a purchase with no supplier straight against the money account", async () => {
    const f = await makeFixture();

    const response = await post("/cash-purchases", purchaseBody(f));

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({ supplier_id: null, supplier_name: null, payable_account_id: null, total_minor: "250000" });
    expect(await journalLines(response.body.journal_id)).toEqual(
      expect.arrayContaining([
        { account_id: f.supplies, debit_minor: "250000", credit_minor: "0", supplier_id: null },
        { account_id: f.cash, debit_minor: "0", credit_minor: "250000", supplier_id: null },
      ]),
    );
    expect((await journalLines(response.body.journal_id)).length).toBe(2);
  });

  it("pays a cheque from the Bank account by default", async () => {
    const f = await makeFixture();

    const response = await post("/cash-purchases", purchaseBody(f, { paymentMethod: "CHEQUE", paidFromAccountId: undefined, reference: "000318" }));
    const tenant = (await get("/tenant")).body;

    if (tenant.system_accounts.BANK) {
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ payment_method: "CHEQUE", paid_from_account_id: tenant.system_accounts.BANK });
    } else {
      expect([response.status, response.body.title]).toEqual([422, "SYSTEM_ACCOUNT_MISSING"]);
    }
  });

  it("refuses OTHER without an account, payableAccountId without a supplier, and bad lines", async () => {
    const f = await makeFixture();

    const other = await post("/cash-purchases", purchaseBody(f, { paymentMethod: "OTHER", paidFromAccountId: undefined }));
    const payableAlone = await post("/cash-purchases", purchaseBody(f, { payableAccountId: f.ap }));
    const noAmount = await post("/cash-purchases", purchaseBody(f, { lines: [{ accountId: f.supplies }] }));
    const unknownSupplier = await post("/cash-purchases", purchaseBody(f, { supplierId: randomUUID(), payableAccountId: f.ap }));

    expect(other.status).toBe(400);
    expect(payableAlone.status).toBe(400);
    expect(noAmount.status).toBe(400);
    expect(unknownSupplier.status).toBe(404);
  });

  it("numbers purchases without gaps and refuses a repeated clientUuid", async () => {
    const f = await makeFixture();
    const body = purchaseBody(f);
    const first = await post("/cash-purchases", body);
    const repeated = await post("/cash-purchases", body);
    const second = await post("/cash-purchases", purchaseBody(f));

    expect(repeated.status).toBe(409);
    const n = (s: string) => Number(s.slice(4));
    expect(n(second.body.number)).toBeGreaterThan(n(first.body.number));
    const count = await withTenant(TEST_TENANT_ID, async (client) => {
      const rows = await client.query<{ count: string; last: number }>(
        `SELECT (SELECT count(*) FROM invoices WHERE kind = 'CASH_PURCHASE')::text AS count,
                (SELECT last_value FROM invoice_number_sequences WHERE kind = 'CASH_PURCHASE') AS last`,
      );
      return rows.rows[0]!;
    });
    expect(Number(count.count)).toBe(count.last);
  });
});

describe("GET /api/v1/cash-purchases", () => {
  it("returns one by id, lists by supplier and search, and keeps them out of bills and cheques", async () => {
    const f = await makeFixture();
    const purchase = (
      await post("/cash-purchases", purchaseBody(f, { supplierId: f.supplierId, payableAccountId: f.ap, supplierReference: `R-${randomUUID().slice(0, 6)}` }))
    ).body;

    const one = await get(`/cash-purchases/${purchase.id}`);
    const bySupplier = await get(`/cash-purchases?supplier_id=${f.supplierId}`);
    const bySearch = await get(`/cash-purchases?q=${encodeURIComponent(purchase.supplier_reference)}`);

    expect(one.status).toBe(200);
    expect(one.body.lines).toHaveLength(1);
    expect(bySupplier.body.data.map((p: { id: string }) => p.id)).toEqual([purchase.id]);
    expect(bySearch.body.data.map((p: { id: string }) => p.id)).toEqual([purchase.id]);
    expect(bySupplier.body.data[0]).not.toHaveProperty("lines");
    expect((await get(`/supplier-bills/${purchase.id}`)).status).toBe(404);
    expect((await get(`/cheque-payments/${purchase.id}`)).status).toBe(404);
    expect((await get(`/supplier-bills?supplier_id=${f.supplierId}`)).body.data).toEqual([]);
    expect((await get(`/cash-purchases/${randomUUID()}`)).status).toBe(404);
  });

  it("lets Cashiers record and see them", () => {
    expect(SYSTEM_ROLES.CASHIER.permissions).toEqual(expect.arrayContaining(["cash_purchases:view", "cash_purchases:create"]));
  });
});
