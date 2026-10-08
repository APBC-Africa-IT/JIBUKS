/**
 * Accounts found by purpose (accounts.system_key): RECEIVABLE, PAYABLE,
 * VAT_INPUT, VAT_OUTPUT, CASH and BANK, seeded by every chart template and
 * used as the defaults on invoices and bills. Each test onboards its own
 * tenant so the shared test tenant's chart doesn't interfere.
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withoutTenant, withTenant } from "@jibuks/db";
import { CHART_TEMPLATE_KEYS, SYSTEM_ACCOUNT_TYPES, templateAccounts, type ChartTemplateKey } from "@jibuks/domain";
import { onboard } from "../src/modules/onboarding/service.js";
import * as accountsService from "../src/modules/accounts/service.js";
import * as customersService from "../src/modules/customers/service.js";
import * as suppliersService from "../src/modules/suppliers/service.js";
import * as invoicesService from "../src/modules/invoices/service.js";
import * as supplierBillsService from "../src/modules/supplierBills/service.js";
import { todayInNairobi } from "../src/modules/periods/service.js";

const today = todayInNairobi();

afterAll(async () => {
  await closePool();
});

async function onboardTenant(chartTemplate: ChartTemplateKey, vatRegistered: boolean) {
  const { tenant, user, accounts } = await onboard({
    tenantName: `System Accounts ${chartTemplate} ${randomUUID().slice(0, 8)}`,
    tenantType: "BUSINESS",
    baseCurrency: "KES",
    externalIdpSubject: `test|${randomUUID()}`,
    userName: "Founder",
    vatRegistered,
    periodStartDate: today.slice(0, 8) + "01",
    chartTemplate,
  });
  const byCode = (code: string) => accounts.find((a) => a.code === code)!;
  return { tenantId: tenant.id, audit: { actorUserId: user.id }, accounts, byCode };
}

/** A tenant with no accounts at all, as if onboarded long ago. */
async function bareTenant() {
  const tenantId = randomUUID();
  const userId = randomUUID();
  await withoutTenant(async (client) => {
    await client.query(`INSERT INTO tenants (id, name, type, base_currency) VALUES ($1, $2, 'BUSINESS', 'KES')`, [
      tenantId,
      `Bare Tenant ${tenantId}`,
    ]);
  });
  await withTenant(tenantId, async (client) => {
    await client.query(`INSERT INTO users (id, tenant_id, external_idp_subject, name) VALUES ($1, $2, $3, 'Bare User')`, [
      userId,
      tenantId,
      `test|${userId}`,
    ]);
  });
  return { tenantId, audit: { actorUserId: userId } };
}

describe("chart templates", () => {
  it("give each key at most once, to an account of the key's type", () => {
    for (const key of CHART_TEMPLATE_KEYS) {
      const tagged = templateAccounts(key, true).filter((a) => a.systemKey);
      const keys = tagged.map((a) => a.systemKey);
      expect(new Set(keys).size, key).toBe(keys.length);
      for (const account of tagged) {
        expect(account.type, `${key} ${account.code}`).toBe(SYSTEM_ACCOUNT_TYPES[account.systemKey!]);
      }
      expect(keys, key).toEqual(expect.arrayContaining(["RECEIVABLE", "PAYABLE", "VAT_INPUT", "VAT_OUTPUT", "CASH"]));
    }
  });

  it("SME_TRADING seeds VAT Payable only for a VAT-registered business", async () => {
    const plain = await onboardTenant("SME_TRADING", false);
    const vat = await onboardTenant("SME_TRADING", true);

    expect(plain.accounts.map((a) => a.code)).not.toContain("2200");
    expect(vat.byCode("2200")).toMatchObject({ name: "VAT Payable", system_key: "VAT_OUTPUT" });
    expect(vat.byCode("1250").system_key).toBe("VAT_INPUT");
    // 1200 is Inventory here, not VAT Recoverable as in GENERAL.
    expect(vat.byCode("1200")).toMatchObject({ name: "Inventory", system_key: null });
  });
});

describe("systemAccountIds", () => {
  it("lists every key with its account id, null where the business has none", async () => {
    const { tenantId, byCode } = await onboardTenant("CORPORATE", false);

    const ids = await accountsService.systemAccountIds(tenantId);

    expect(ids).toEqual({
      MPESA: null,
      OPENING_BALANCE: byCode("3900").id,
      RECEIVABLE: byCode("1100").id,
      PAYABLE: byCode("2000").id,
      VAT_INPUT: null,
      VAT_OUTPUT: null,
      CASH: byCode("1000").id,
      BANK: null,
    });
  });
});

describe("invoice and bill defaults", () => {
  it("an invoice without receivable or VAT accounts uses the business's RECEIVABLE and VAT_OUTPUT", async () => {
    const { tenantId, audit, byCode } = await onboardTenant("GENERAL", true);
    const customer = await customersService.createCustomer({ tenantId, name: "Default Customer" }, audit);

    const invoice = await invoicesService.createInvoice(
      {
        tenantId,
        clientUuid: randomUUID(),
        kind: "INVOICE",
        customerId: customer.id,
        issueDate: today,
        taxMode: "EXCLUSIVE",
        lines: [{ description: "Flour", quantity: 1, unitPriceMinor: 10000, incomeAccountId: byCode("4000").id, taxRateBps: 1600 }],
      },
      audit,
    );

    expect(invoice.receivable_account_id).toBe(byCode("1100").id);
    expect(invoice.lines[0]!.tax_account_id).toBe(byCode("2100").id);
  });

  it("a bill without payable or VAT accounts uses the business's PAYABLE and VAT_INPUT", async () => {
    const { tenantId, audit, byCode } = await onboardTenant("SME_TRADING", true);
    const supplier = await suppliersService.createSupplier({ tenantId, name: "Default Supplier" }, audit);

    const bill = await supplierBillsService.createBill(
      {
        tenantId,
        clientUuid: randomUUID(),
        supplierId: supplier.id,
        billDate: today,
        taxMode: "EXCLUSIVE",
        lines: [{ description: "Stock", quantity: 1, unitPriceMinor: 10000, expenseAccountId: byCode("5000").id, taxRateBps: 1600 }],
      },
      audit,
    );

    expect(bill.payable_account_id).toBe(byCode("2000").id);
    expect(bill.lines[0]!.tax_account_id).toBe(byCode("1250").id);
  });

  it("a pro-forma takes no receivable account until it's converted", async () => {
    const { tenantId, audit, byCode } = await onboardTenant("MICRO_TRADER", false);
    const customer = await customersService.createCustomer({ tenantId, name: "Quote Customer" }, audit);

    const proforma = await invoicesService.createInvoice(
      {
        tenantId,
        clientUuid: randomUUID(),
        kind: "PROFORMA",
        customerId: customer.id,
        issueDate: today,
        taxMode: "NONE",
        lines: [{ description: "Quote", quantity: 1, unitPriceMinor: 5000, incomeAccountId: byCode("4000").id, taxRateBps: 0 }],
      },
      audit,
    );
    const converted = await invoicesService.convertProforma(
      { tenantId, proformaId: proforma.id, clientUuid: randomUUID() },
      audit,
    );

    expect(proforma.receivable_account_id).toBeNull();
    expect(converted.receivable_account_id).toBe(byCode("1030").id);
  });

  it("422 SYSTEM_ACCOUNT_MISSING when the business has no such account marked", async () => {
    const { tenantId, audit } = await bareTenant();
    const customer = await customersService.createCustomer({ tenantId, name: "Old Customer" }, audit);
    const sales = await accountsService.createAccount({ tenantId, code: "4000", name: "Sales", type: "INCOME" }, audit);

    await expect(
      invoicesService.createInvoice(
        {
          tenantId,
          clientUuid: randomUUID(),
          kind: "INVOICE",
          customerId: customer.id,
          issueDate: today,
          taxMode: "NONE",
          lines: [{ description: "x", quantity: 1, unitPriceMinor: 100, incomeAccountId: sales.id, taxRateBps: 0 }],
        },
        audit,
      ),
    ).rejects.toMatchObject({ code: "SYSTEM_ACCOUNT_MISSING", details: [{ path: "receivableAccountId" }] });
  });
});

describe("PATCH /accounts/{id} systemKey", () => {
  it("moves a key to another account of the right type, taking it off the old one", async () => {
    const { tenantId, audit, byCode } = await onboardTenant("GENERAL", false);
    const debtors = await accountsService.createAccount({ tenantId, code: "1150", name: "Debtors", type: "ASSET" }, audit);

    const moved = await accountsService.updateAccount(tenantId, debtors.id, { systemKey: "RECEIVABLE" }, audit);
    const old = await accountsService.getAccount(tenantId, byCode("1100").id);
    const ids = await accountsService.systemAccountIds(tenantId);

    expect(moved.system_key).toBe("RECEIVABLE");
    expect(old.system_key).toBeNull();
    expect(ids.RECEIVABLE).toBe(debtors.id);
  });

  it("refuses an account of the wrong type, or one that already has another key", async () => {
    const { tenantId, audit, byCode } = await onboardTenant("GENERAL", false);

    await expect(
      accountsService.updateAccount(tenantId, byCode("2000").id, { systemKey: "RECEIVABLE" }, audit),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_POSTABLE" });
    await expect(
      accountsService.updateAccount(tenantId, byCode("1000").id, { systemKey: "BANK" }, audit),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_POSTABLE" });
    expect((await accountsService.systemAccountIds(tenantId)).BANK).toBe(byCode("1010").id);
  });
});
