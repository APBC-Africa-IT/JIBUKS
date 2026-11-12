/**
 * The Add Supplier screen's details (code, type, address, VAT, payment
 * details, opening balance), the Supplier Type list (/supplier-types), the
 * supplier list's search and "(Overdue)" / "(Due)" tag, and the address
 * fields customers share.
 *
 * Opening balances are business-wide, so a supplier's opening balance is
 * tested on separately onboarded businesses through the service; the
 * shared test business is used for everything else.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@jibuks/db";
import { DEFAULT_SUPPLIER_TYPES } from "@jibuks/domain";
import { createApp } from "../src/app.js";
import { listen } from "./testServer.js";
import { onboard } from "../src/modules/onboarding/service.js";
import * as openingBalances from "../src/modules/openingBalances/service.js";
import * as suppliersService from "../src/modules/suppliers/service.js";
import { todayInNairobi } from "../src/modules/periods/service.js";
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

const unique = (prefix: string) => `${prefix} ${randomUUID().slice(0, 8)}`;

async function call(method: "get" | "post" | "patch", path: string, body?: object) {
  const req = request(app)[method](`/api/v1${path}`).set({ Authorization: await authHeader() });
  return body ? req.send(body) : req;
}

async function ok(method: "get" | "post" | "patch", path: string, body?: object) {
  const response = await call(method, path, body);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  return response.body;
}

async function typeId(name: string): Promise<string> {
  const types = (await ok("get", "/supplier-types")).data as { id: string; name: string }[];
  return types.find((t) => t.name === name)!.id;
}

describe("supplier types", () => {
  it("every business starts with the five default types", async () => {
    const names = ((await ok("get", "/supplier-types")).data as { name: string }[]).map((t) => t.name);

    expect(names).toEqual(expect.arrayContaining([...DEFAULT_SUPPLIER_TYPES]));
  });

  it("+ Add type adds one; the same name in another case is a duplicate; a type can be renamed", async () => {
    const name = unique("Contractor");
    const created = await ok("post", "/supplier-types", { name });
    const duplicate = await call("post", "/supplier-types", { name: name.toUpperCase() });
    const renamed = await ok("patch", `/supplier-types/${created.id}`, { name: `${name} Ltd` });
    const missing = await call("patch", `/supplier-types/${randomUUID()}`, { name: "Nobody" });

    expect(created).toMatchObject({ name, supplier_count: 0 });
    expect(duplicate.status).toBe(409);
    expect(renamed.name).toBe(`${name} Ltd`);
    expect(missing.status).toBe(404);
    expect(missing.body.title).toBe("SUPPLIER_TYPE_NOT_FOUND");
    expect((await call("post", "/supplier-types", { name: " " })).status).toBe(400);
  });

  it("onboarding gives a new business the default types", async () => {
    const { tenant } = await onboard({
      tenantName: "Types Shop",
      tenantType: "BUSINESS",
      baseCurrency: "KES",
      externalIdpSubject: `test|${randomUUID()}`,
      userName: "Owner",
      vatRegistered: false,
      periodStartDate: today.slice(0, 8) + "01",
    });

    const names = (await suppliersService.listSupplierTypes(tenant.id)).map((t) => t.name);

    expect(names.sort()).toEqual([...DEFAULT_SUPPLIER_TYPES].sort());
  });
});

describe("Add Supplier", () => {
  it("stores every field on the screen and gives the supplier the next SUP- code", async () => {
    const wholesaler = await typeId("Wholesaler");
    const first = await ok("post", "/suppliers", { name: unique("Code One") });
    const supplier = await ok("post", "/suppliers", {
      name: unique("FreshFarm"),
      supplierTypeId: wholesaler,
      phone: "+254722000000",
      email: "orders@freshfarm.example",
      address: "Kangundo Road",
      city: "Nairobi",
      country: "ke",
      postalCode: "00100",
      taxIdentifier: "P051234567X",
      vatRegistered: true,
      defaultTaxRateBps: 1600,
      preferredPaymentMethod: "MPESA",
      bankName: "KCB",
      bankAccountNumber: "1234567890",
      mpesaPhone: "+254722000000",
      mpesaPaybillTill: "522522",
      paymentTermsDays: 30,
      currency: "KES",
      isActive: false,
    });

    expect(supplier).toMatchObject({
      supplier_type_id: wholesaler,
      supplier_type_name: "Wholesaler",
      city: "Nairobi",
      country: "KE",
      postal_code: "00100",
      vat_registered: true,
      default_tax_rate_bps: 1600,
      preferred_payment_method: "MPESA",
      bank_name: "KCB",
      bank_account_number: "1234567890",
      mpesa_phone: "+254722000000",
      mpesa_paybill_till: "522522",
      payment_terms_days: 30,
      is_active: false,
      balance_minor: "0",
      payment_status: "SETTLED",
    });
    expect(supplier.code).toMatch(/^SUP-\d{4,}$/);
    expect(Number(supplier.code.slice(4))).toBeGreaterThan(Number(first.code.slice(4)));
  });

  it("rejects a VAT rate for a supplier that isn't VAT registered, a bad country and an unknown type", async () => {
    const noVat = await call("post", "/suppliers", { name: unique("No VAT"), defaultTaxRateBps: 1600 });
    const badCountry = await call("post", "/suppliers", { name: unique("Bad Country"), country: "Kenya" });
    const badType = await call("post", "/suppliers", { name: unique("Bad Type"), supplierTypeId: randomUUID() });
    const zeroRate = await call("post", "/suppliers", { name: unique("Zero Rated"), defaultTaxRateBps: 0 });

    expect(noVat.status).toBe(400);
    expect(noVat.body.errors[0].path).toBe("defaultTaxRateBps");
    expect(badCountry.status).toBe(400);
    expect(badType.status).toBe(404);
    expect(badType.body.title).toBe("SUPPLIER_TYPE_NOT_FOUND");
    expect(zeroRate.status).toBe(201);
  });

  it("PATCH changes the new fields and keeps the VAT rule against what is stored", async () => {
    const supplier = await ok("post", "/suppliers", { name: unique("Patch Me") });

    const vatWithoutRegistration = await call("patch", `/suppliers/${supplier.id}`, { defaultTaxRateBps: 1600 });
    const updated = await ok("patch", `/suppliers/${supplier.id}`, {
      vatRegistered: true,
      defaultTaxRateBps: 800,
      city: "Mombasa",
      supplierTypeId: await typeId("Manufacturer"),
      bankName: "Equity",
    });
    const cleared = await ok("patch", `/suppliers/${supplier.id}`, { city: null, supplierTypeId: null });

    expect(vatWithoutRegistration.status).toBe(422);
    expect(vatWithoutRegistration.body.title).toBe("TAX_NOT_REGISTERED");
    expect(updated).toMatchObject({ vat_registered: true, default_tax_rate_bps: 800, city: "Mombasa", bank_name: "Equity" });
    expect(cleared).toMatchObject({ city: null, supplier_type_id: null });
    expect(supplier.code).toBe(cleared.code);
  });

  it("rejects an opening balance of zero", async () => {
    const response = await call("post", "/suppliers", {
      name: unique("Opening"),
      openingBalance: { amountMinor: 0, date: today },
    });

    expect(response.status).toBe(400);
    expect(response.body.errors[0].path).toBe("openingBalance.amountMinor");
  });
});

describe("GET /suppliers", () => {
  it("searches name, code, phone and email, and filters by type", async () => {
    const distributor = await typeId("Distributor");
    const name = unique("Searchable");
    const supplier = await ok("post", "/suppliers", { name, supplierTypeId: distributor, phone: "+254733999111" });

    const byName = (await ok("get", `/suppliers?q=${encodeURIComponent(name.toLowerCase())}`)).data;
    const byCode = (await ok("get", `/suppliers?q=${supplier.code}`)).data;
    const byType = (await ok("get", `/suppliers?supplier_type_id=${distributor}`)).data as { id: string; supplier_type_id: string }[];

    expect(byName.map((s: { id: string }) => s.id)).toEqual([supplier.id]);
    expect(byCode.map((s: { id: string }) => s.id)).toEqual([supplier.id]);
    expect(byType.some((s) => s.id === supplier.id)).toBe(true);
    expect(byType.every((s) => s.supplier_type_id === distributor)).toBe(true);
  });

  it("tags a supplier OVERDUE once a posted bill is past due, DUE before that", async () => {
    const supplier = await ok("post", "/suppliers", { name: unique("Tagged") });
    const expense = await ok("post", "/accounts", { code: randomUUID().slice(0, 8), name: "Tag Rent", type: "EXPENSE" });
    const payable = await ok("post", "/accounts", { code: randomUUID().slice(0, 8), name: "Tag AP", type: "LIABILITY" });
    const draft = await ok("post", "/supplier-bills", {
      clientUuid: randomUUID(),
      supplierId: supplier.id,
      payableAccountId: payable.id,
      billDate: today,
      dueDate: addDays(today, 5),
      lines: [{ description: "Rent", quantity: 1, unitPriceMinor: 32500, expenseAccountId: expense.id }],
    });
    await ok("post", `/supplier-bills/${draft.id}/post`);

    const now = await ok("get", `/suppliers/${supplier.id}`);
    const later = await ok("get", `/suppliers/${supplier.id}?as_of=${addDays(today, 10)}`);
    const listed = (await ok("get", `/suppliers?q=${supplier.code}&as_of=${addDays(today, 10)}`)).data[0];

    expect(now).toMatchObject({ balance_minor: "32500", overdue_minor: "0", payment_status: "DUE" });
    expect(later).toMatchObject({ balance_minor: "32500", overdue_minor: "32500", payment_status: "OVERDUE" });
    expect(listed).toMatchObject({ overdue_minor: "32500", payment_status: "OVERDUE" });
  });
});

describe("supplier opening balance", () => {
  async function business() {
    const { tenant, user, accounts } = await onboard({
      tenantName: "Supplier Opening Shop",
      tenantType: "BUSINESS",
      baseCurrency: "KES",
      externalIdpSubject: `test|${randomUUID()}`,
      userName: "Owner",
      vatRegistered: false,
      periodStartDate: "2026-09-01",
      chartTemplate: "SME_TRADING",
    });
    const code = (c: string) => accounts.find((a) => a.code === c)!.id;
    return { tenantId: tenant.id, audit: { actorUserId: user.id }, cash: code("1000"), payable: code("2000") };
  }

  it("creates the supplier and adds Cr Accounts Payable to the business's opening balances, keeping what was there", async () => {
    const b = await business();
    await openingBalances.setOpeningBalances(
      { tenantId: b.tenantId, date: "2026-09-01", lines: [{ accountId: b.cash, debitMinor: 100000, creditMinor: 0 }] },
      b.audit,
    );

    const supplier = await openingBalances.createSupplierWithOpeningBalance(
      { tenantId: b.tenantId, name: "Unga Ltd" },
      { amountMinor: 24530000, date: "2026-09-01" },
      b.audit,
    );
    const view = await openingBalances.getOpeningBalances(b.tenantId);
    const lines = view.journal!.lines;

    expect(supplier.code).toBe("SUP-0001");
    expect((await suppliersService.getSupplier(b.tenantId, supplier.id)).balance_minor).toBe("24530000");
    expect(lines.find((l) => l.account_id === b.cash)!.debit_minor).toBe("100000");
    expect(lines.find((l) => l.supplier_id === supplier.id)).toMatchObject({ account_id: b.payable, credit_minor: "24530000" });
    expect(lines.find((l) => l.account_id === view.opening_balance_account_id)!.debit_minor).toBe("24430000");
  });

  it("sets the opening date when the business has none yet", async () => {
    const b = await business();

    await openingBalances.createSupplierWithOpeningBalance(
      { tenantId: b.tenantId, name: "First Supplier" },
      { amountMinor: 5000, date: "2026-09-15" },
      b.audit,
    );

    expect((await openingBalances.getOpeningBalances(b.tenantId)).date).toBe("2026-09-15");
  });

  it("refuses another date or currency, and then creates no supplier", async () => {
    const b = await business();
    await openingBalances.createSupplierWithOpeningBalance(
      { tenantId: b.tenantId, name: "Dated" },
      { amountMinor: 5000, date: "2026-09-01" },
      b.audit,
    );

    await expect(
      openingBalances.createSupplierWithOpeningBalance(
        { tenantId: b.tenantId, name: "Wrong Date" },
        { amountMinor: 5000, date: "2026-09-02" },
        b.audit,
      ),
    ).rejects.toMatchObject({ code: "OPENING_BALANCE_DATE_MISMATCH" });
    await expect(
      openingBalances.createSupplierWithOpeningBalance(
        { tenantId: b.tenantId, name: "Dollar Supplier", currency: "USD" },
        { amountMinor: 5000, date: "2026-09-01" },
        b.audit,
      ),
    ).rejects.toMatchObject({ code: "CURRENCY_MISMATCH" });
    expect((await suppliersService.listSuppliers(b.tenantId)).map((s) => s.name)).toEqual(["Dated"]);
  });

  it("rolls the supplier back when the opening journal can't be posted", async () => {
    const b = await business();
    await openingBalances.setOpeningBalances(
      { tenantId: b.tenantId, date: "2026-09-01", lines: [{ accountId: b.cash, debitMinor: 100, creditMinor: 0 }] },
      b.audit,
    );
    await withTenant(b.tenantId, async (client) => {
      await client.query(`UPDATE periods SET status = 'CLOSED' WHERE start_date = '2026-09-01'`);
    });

    const attempt = openingBalances.createSupplierWithOpeningBalance(
      { tenantId: b.tenantId, name: "Too Late" },
      { amountMinor: 5000, date: "2026-09-01" },
      b.audit,
    );

    await expect(attempt).rejects.toMatchObject({ code: "OPENING_BALANCES_LOCKED" });
    expect(await suppliersService.listSuppliers(b.tenantId)).toEqual([]);
  });
});

describe("customer address", () => {
  it("customers take city, country and postal code too", async () => {
    const customer = await ok("post", "/customers", { name: unique("Address"), city: "Kisumu", country: "ke", postalCode: "40100" });
    const updated = await ok("patch", `/customers/${customer.id}`, { postalCode: null });
    const fetched = await ok("get", `/customers/${customer.id}`);

    expect(customer).toMatchObject({ city: "Kisumu", country: "KE", postal_code: "40100" });
    expect(updated.postal_code).toBeNull();
    expect(fetched).toMatchObject({ city: "Kisumu", country: "KE" });
  });
});
