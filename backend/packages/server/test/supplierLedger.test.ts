/**
 * Supplier ledger: a supplier's transaction history, the list's last
 * activity, and the Suppliers hub's Overview (/payables-overview).
 *
 * Totals are business-wide, so the history and the Overview are tested on
 * a separately onboarded business, with fixed September dates, through the
 * services; the HTTP routes are checked on the shared test business.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@jibuks/db";
import { createApp } from "../src/app.js";
import { listen } from "./testServer.js";
import { onboard } from "../src/modules/onboarding/service.js";
import * as openingBalances from "../src/modules/openingBalances/service.js";
import * as supplierBills from "../src/modules/supplierBills/service.js";
import * as supplierLedger from "../src/modules/supplierLedger/service.js";
import * as suppliersService from "../src/modules/suppliers/service.js";
import { todayInNairobi } from "../src/modules/periods/service.js";
import { authHeader } from "./testAuth.js";

const app = await listen(createApp());

afterAll(async () => {
  await closePool();
});

async function call(method: "get" | "post", path: string, body?: object) {
  const req = request(app)[method](`/api/v1${path}`).set({ Authorization: await authHeader() });
  return body ? req.send(body) : req;
}

async function ok(method: "get" | "post", path: string, body?: object) {
  const response = await call(method, path, body);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  return response.body;
}

async function business() {
  const { tenant, user, accounts } = await onboard({
    tenantName: "Supplier Ledger Shop",
    tenantType: "BUSINESS",
    baseCurrency: "KES",
    externalIdpSubject: `test|${randomUUID()}`,
    userName: "Owner",
    vatRegistered: false,
    periodStartDate: "2026-09-01",
    chartTemplate: "SME_TRADING",
  });
  const audit = { actorUserId: user.id };
  const tenantId = tenant.id;
  const cash = accounts.find((a) => a.code === "1000")!.id;
  const expense = accounts.find((a) => a.type === "EXPENSE")!.id;

  async function bill(supplierId: string, amount: number, billDate: string, dueDate: string) {
    const draft = await supplierBills.createBill(
      {
        tenantId,
        clientUuid: randomUUID(),
        supplierId,
        billDate,
        dueDate,
        taxMode: "NONE",
        lines: [{ description: "Stock", quantity: 1, unitPriceMinor: amount, expenseAccountId: expense, taxRateBps: 0 }],
      },
      audit,
    );
    return supplierBills.postBill(tenantId, draft.id, audit);
  }

  return { tenantId, audit, cash, expense, bill };
}

describe("supplier transaction history", () => {
  it("names every row and keeps a running balance of what the business owes", async () => {
    const b = await business();
    const supplier = await openingBalances.createSupplierWithOpeningBalance(
      { tenantId: b.tenantId, name: "Unga Ltd" },
      { amountMinor: 10000, date: "2026-09-01" },
      b.audit,
    );
    const bill = await b.bill(supplier.id, 50000, "2026-09-05", "2026-09-20");
    await supplierBills.payBill(
      {
        tenantId: b.tenantId,
        billId: bill.id,
        clientUuid: randomUUID(),
        amountMinor: 20000,
        date: "2026-09-10",
        paidFromAccountId: b.cash,
        method: "MPESA",
        reference: "QAB12CD34E",
      },
      b.audit,
    );
    const note = await supplierBills.createDebitNote(
      {
        tenantId: b.tenantId,
        billId: bill.id,
        clientUuid: randomUUID(),
        noteDate: "2026-09-12",
        lines: [{ description: "Returned", quantity: 1, unitPriceMinor: 5000, expenseAccountId: b.expense, taxRateBps: 0 }],
      },
      b.audit,
    );
    await supplierBills.postBill(b.tenantId, note.id, b.audit);

    const all = await supplierLedger.getSupplierTransactions({ tenantId: b.tenantId, supplierId: supplier.id });
    const fromBill = await supplierLedger.getSupplierTransactions({
      tenantId: b.tenantId,
      supplierId: supplier.id,
      from: "2026-09-05",
      to: "2026-09-10",
    });

    expect(all.data.map((r) => [r.type, r.credit_minor, r.debit_minor, r.balance_minor])).toEqual([
      ["OPENING_BALANCE", "10000", "0", "10000"],
      ["BILL", "50000", "0", "60000"],
      ["PAYMENT", "0", "20000", "40000"],
      ["DEBIT_NOTE", "0", "5000", "35000"],
    ]);
    expect(all.data[1]).toMatchObject({ document_id: bill.id, document_kind: "BILL", document_number: bill.number });
    expect(all.data[2]).toMatchObject({
      payment_method: "MPESA",
      reference: "QAB12CD34E",
      paid_bills: [{ bill_id: bill.id, bill_number: bill.number, amount_minor: "20000" }],
    });
    expect(all.data[3]).toMatchObject({ document_kind: "DEBIT_NOTE", debited_bill_id: bill.id, debited_bill_number: bill.number });
    expect(all).toMatchObject({ opening_balance_minor: "0", total_credit_minor: "60000", total_debit_minor: "25000", closing_balance_minor: "35000" });
    expect(all.closing_balance_minor).toBe((await suppliersService.getSupplier(b.tenantId, supplier.id)).balance_minor);
    expect(fromBill).toMatchObject({ opening_balance_minor: "10000", closing_balance_minor: "40000" });
    expect(fromBill.data.map((r) => r.type)).toEqual(["BILL", "PAYMENT"]);
  });

  it("names a cancelled bill's reversal", async () => {
    const b = await business();
    const supplier = await suppliersService.createSupplier({ tenantId: b.tenantId, name: "Cancelled" }, b.audit);
    const bill = await b.bill(supplier.id, 7000, "2026-09-05", "2026-09-20");
    await supplierBills.cancelBill(b.tenantId, bill.id, "Entered twice", b.audit);

    const history = await supplierLedger.getSupplierTransactions({ tenantId: b.tenantId, supplierId: supplier.id });

    expect(history.data.map((r) => [r.type, r.document_id])).toEqual([
      ["BILL", bill.id],
      ["BILL_CANCELLED", bill.id],
    ]);
    expect(history.closing_balance_minor).toBe("0");
  });

  it("gives each supplier a named last activity", async () => {
    const b = await business();
    const supplier = await suppliersService.createSupplier({ tenantId: b.tenantId, name: "Active" }, b.audit);
    const quiet = await suppliersService.createSupplier({ tenantId: b.tenantId, name: "Quiet" }, b.audit);
    const bill = await b.bill(supplier.id, 7000, "2026-09-05", "2026-09-20");

    const entries = await supplierLedger.listSupplierEntries(b.tenantId, { asOf: "2026-09-30" });
    const before = await supplierLedger.getSupplierEntry(b.tenantId, supplier.id, "2026-09-04");

    expect(entries.find((s) => s.id === supplier.id)).toMatchObject({
      last_activity: { type: "BILL", date: "2026-09-05", document_number: bill.number },
      payment_status: "OVERDUE",
      overdue_minor: "7000",
    });
    expect(entries.find((s) => s.id === quiet.id)!.last_activity).toBeNull();
    expect(before.last_activity).toBeNull();
  });
});

describe("payables overview", () => {
  it("totals what is owed, overdue and due within the window, and lists recent activity newest first", async () => {
    const b = await business();
    const abc = await suppliersService.createSupplier({ tenantId: b.tenantId, name: "ABC Traders" }, b.audit);
    const kplc = await suppliersService.createSupplier({ tenantId: b.tenantId, name: "KPLC" }, b.audit);
    await b.bill(abc.id, 48000, "2026-09-02", "2026-09-20"); // overdue on the 23rd
    await b.bill(kplc.id, 3200, "2026-09-03", "2026-09-23"); // due that day
    await b.bill(kplc.id, 73300, "2026-09-04", "2026-09-30"); // due in 7 days
    const late = await b.bill(abc.id, 120800, "2026-09-05", "2026-10-15"); // not soon

    const overview = await supplierLedger.getPayablesOverview({ tenantId: b.tenantId, asOf: "2026-09-23", dueSoonDays: 7, recentLimit: 3 });
    const narrow = await supplierLedger.getPayablesOverview({ tenantId: b.tenantId, asOf: "2026-09-23", dueSoonDays: 1, recentLimit: 10 });

    expect(overview).toMatchObject({
      as_of: "2026-09-23",
      currency: "KES",
      total_payables_minor: "245300",
      overdue_minor: "48000",
      overdue_bill_count: 1,
      due_soon_days: 7,
      due_soon_minor: "76500",
      due_soon_bill_count: 2,
    });
    expect(overview.recent_activity).toHaveLength(3);
    expect(overview.recent_activity[0]).toMatchObject({
      supplier_id: abc.id,
      supplier_name: "ABC Traders",
      type: "BILL",
      date: "2026-09-05",
      document_number: late.number,
      credit_minor: "120800",
    });
    expect(overview.recent_activity.map((r) => r.date)).toEqual(["2026-09-05", "2026-09-04", "2026-09-03"]);
    expect(narrow).toMatchObject({ due_soon_minor: "3200", due_soon_bill_count: 1 });
  });
});

describe("HTTP", () => {
  it("GET /suppliers/{id}/transactions, last_activity on the list, and GET /payables-overview", async () => {
    const supplier = await ok("post", "/suppliers", { name: `Ledger ${randomUUID().slice(0, 8)}` });

    const empty = await ok("get", `/suppliers/${supplier.id}/transactions`);
    const badRange = await call("get", `/suppliers/${supplier.id}/transactions?from=2026-09-30&to=2026-09-01`);
    const missing = await call("get", `/suppliers/${randomUUID()}/transactions`);
    const listed = (await ok("get", `/suppliers?q=${supplier.code}`)).data[0];
    const overview = await ok("get", `/payables-overview?due_soon_days=14&recent_limit=5`);
    const badWindow = await call("get", "/payables-overview?due_soon_days=0");

    expect(empty).toMatchObject({ supplier_id: supplier.id, closing_balance_minor: "0", data: [] });
    expect(badRange.status).toBe(400);
    expect(missing.status).toBe(404);
    expect(supplier.last_activity).toBeNull();
    expect(listed.last_activity).toBeNull();
    expect(overview).toMatchObject({ as_of: todayInNairobi(), due_soon_days: 14 });
    expect(overview.recent_activity.length).toBeLessThanOrEqual(5);
    expect(badWindow.status).toBe(400);
  });
});
