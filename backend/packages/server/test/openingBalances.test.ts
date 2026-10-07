/**
 * Opening balances (FR-ACC-04). Opening balances are tenant-wide and one
 * test closes a period, so each test onboards its own business and calls
 * the service directly; the HTTP layer is checked on the shared tenant
 * for reads and validation only.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@jibuks/db";
import { createApp } from "../src/app.js";
import { listen } from "./testServer.js";
import { authHeader } from "./testAuth.js";
import { onboard } from "../src/modules/onboarding/service.js";
import * as openingBalances from "../src/modules/openingBalances/service.js";
import * as accountsService from "../src/modules/accounts/service.js";
import * as customersService from "../src/modules/customers/service.js";
import * as suppliersService from "../src/modules/suppliers/service.js";
import * as periodsService from "../src/modules/periods/service.js";
import * as journalsService from "../src/modules/journals/service.js";

const app = await listen(createApp());

afterAll(async () => {
  await closePool();
});

async function business() {
  const { tenant, user, accounts, period } = await onboard({
    tenantName: "Opening Balances Shop",
    tenantType: "BUSINESS",
    baseCurrency: "KES",
    externalIdpSubject: `test|${randomUUID()}`,
    userName: "Owner",
    vatRegistered: false,
    periodStartDate: "2026-09-01",
    chartTemplate: "SME_TRADING",
  });
  const audit = { actorUserId: user.id };
  const code = (c: string) => accounts.find((a) => a.code === c)!.id;
  return {
    tenantId: tenant.id,
    audit,
    period,
    cash: code("1000"),
    bank: code("1010"),
    receivable: code("1030"),
    stock: code("1200"),
    payable: code("2000"),
    obe: code("3900"),
    customer: await customersService.createCustomer({ tenantId: tenant.id, name: "Wanjiku" }, audit),
    supplier: await suppliersService.createSupplier({ tenantId: tenant.id, name: "Unga Ltd" }, audit),
  };
}

const balanceOf = async (tenantId: string, accountId: string) =>
  (await accountsService.getAccount(tenantId, accountId)).balance_minor;

describe("opening balances", () => {
  it("posts one OPENING journal, balanced against Opening Balance Equity, with party balances", async () => {
    const b = await business();

    const result = await openingBalances.setOpeningBalances(
      {
        tenantId: b.tenantId,
        date: "2026-09-01",
        lines: [
          { accountId: b.cash, debitMinor: 5_000_000, creditMinor: 0 },
          { accountId: b.bank, debitMinor: 10_000_000, creditMinor: 0 },
          { accountId: b.stock, debitMinor: 2_500_000, creditMinor: 0 },
          { accountId: b.receivable, debitMinor: 2_000_000, creditMinor: 0, customerId: b.customer.id },
          { accountId: b.payable, debitMinor: 0, creditMinor: 3_000_000, supplierId: b.supplier.id },
        ],
      },
      b.audit,
    );

    expect(result).toMatchObject({ date: "2026-09-01", locked: false, opening_balance_account_id: b.obe });
    expect(result.journal).toMatchObject({ source: "OPENING", status: "POSTED", date: "2026-09-01" });
    expect(result.journal!.lines.find((l) => l.account_id === b.obe)).toMatchObject({
      debit_minor: "0",
      credit_minor: "16500000",
    });
    expect(await balanceOf(b.tenantId, b.cash)).toBe("5000000");
    expect((await customersService.getCustomer(b.tenantId, b.customer.id)).balance_minor).toBe("2000000");
    expect((await suppliersService.getSupplier(b.tenantId, b.supplier.id)).balance_minor).toBe("3000000");
  });

  it("replaces them: the old journal is reversed on its own date and only the new one counts", async () => {
    const b = await business();
    const first = await openingBalances.setOpeningBalances(
      { tenantId: b.tenantId, date: "2026-09-01", lines: [{ accountId: b.cash, debitMinor: 5_000_000, creditMinor: 0 }] },
      b.audit,
    );

    const second = await openingBalances.setOpeningBalances(
      { tenantId: b.tenantId, date: "2026-09-01", lines: [{ accountId: b.cash, debitMinor: 7_000_000, creditMinor: 0 }] },
      b.audit,
    );

    expect(second.journal!.id).not.toBe(first.journal!.id);
    expect(await balanceOf(b.tenantId, b.cash)).toBe("7000000");
    expect(await balanceOf(b.tenantId, b.obe)).toBe("7000000");
    const reversal = (await journalsService.listJournals(b.tenantId)).find((j) => j.reversal_of_journal_id === first.journal!.id);
    expect(reversal).toMatchObject({ date: "2026-09-01" });
  });

  it("locks them once their period is closed", async () => {
    const b = await business();
    await openingBalances.setOpeningBalances(
      { tenantId: b.tenantId, date: "2026-09-01", lines: [{ accountId: b.cash, debitMinor: 100, creditMinor: 0 }] },
      b.audit,
    );
    await periodsService.closePeriod(b.tenantId, b.period.id, b.audit);

    const view = await openingBalances.getOpeningBalances(b.tenantId);
    const change = openingBalances.setOpeningBalances(
      { tenantId: b.tenantId, date: "2026-09-01", lines: [{ accountId: b.cash, debitMinor: 200, creditMinor: 0 }] },
      b.audit,
    );

    expect(view.locked).toBe(true);
    await expect(change).rejects.toMatchObject({ code: "OPENING_BALANCES_LOCKED" });
  });

  it("refuses a line on Opening Balance Equity itself", async () => {
    const b = await business();

    const attempt = openingBalances.setOpeningBalances(
      { tenantId: b.tenantId, date: "2026-09-01", lines: [{ accountId: b.obe, debitMinor: 0, creditMinor: 100 }] },
      b.audit,
    );

    await expect(attempt).rejects.toMatchObject({ code: "JOURNAL_LINE_AMBIGUOUS" });
  });

  it("creates Opening Balance Equity for a business that predates it", async () => {
    const b = await business();
    // An older business: no account carries the key.
    await accountsService.updateAccount(b.tenantId, b.obe, { code: "3999-old" }, b.audit);
    const { withTenant } = await import("@jibuks/db");
    await withTenant(b.tenantId, (client) => client.query(`UPDATE accounts SET system_key = NULL WHERE id = $1`, [b.obe]));

    const result = await openingBalances.setOpeningBalances(
      { tenantId: b.tenantId, date: "2026-09-01", lines: [{ accountId: b.cash, debitMinor: 100, creditMinor: 0 }] },
      b.audit,
    );

    const created = await accountsService.getAccount(b.tenantId, result.opening_balance_account_id!);
    expect(created).toMatchObject({ code: "3900", name: "Opening Balance Equity", type: "EQUITY", system_key: "OPENING_BALANCE" });
  });
});

describe("/api/v1/opening-balances (HTTP)", () => {
  it("GET answers with the current opening balances, and PUT validates its body", async () => {
    const get = await request(app).get("/api/v1/opening-balances").set("Authorization", await authHeader());
    const bad = await request(app)
      .put("/api/v1/opening-balances")
      .set("Authorization", await authHeader())
      .send({ date: "2026-09-01", lines: [] });

    expect(get.status).toBe(200);
    expect(get.body).toHaveProperty("locked");
    expect(bad.status).toBe(400);
  });
});
