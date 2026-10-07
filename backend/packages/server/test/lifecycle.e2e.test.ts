/**
 * Full lifecycle end-to-end test: register (onboarding) through every
 * guided transaction endpoint to the three reports the mobile app
 * consumes (Trial Balance, Profit & Loss, Cash Flow) -- run once for a
 * VAT-registered tenant and once for a non-VAT tenant, since VAT changes
 * which accounts get touched but must never change what the P&L reports.
 *
 * This calls the exact service functions each HTTP controller calls (see
 * modules/*\/service.ts) directly, rather than over HTTP. HTTP-level auth
 * for a BRAND NEW identity needs a real Auth0 login, which this test
 * environment doesn't have -- see onboarding.test.ts's note, and every
 * module below already has its own HTTP-level tests (auth, validation,
 * error codes) in its own *.test.ts file. This test's job is different:
 * proving the pieces compose correctly across a single tenant's whole
 * lifecycle, end to end, which no single module's test file can show.
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@jibuks/db";
import type { AuditContext } from "@jibuks/db";
import type { AccountRow } from "../src/modules/accounts/repository.js";
import { onboard } from "../src/modules/onboarding/service.js";
import * as customersService from "../src/modules/customers/service.js";
import * as suppliersService from "../src/modules/suppliers/service.js";
import { createCreditSale } from "../src/modules/creditSales/service.js";
import { createCashSale } from "../src/modules/cashSales/service.js";
import { createWriteBill } from "../src/modules/bills/service.js";
import { createWriteCheque } from "../src/modules/cheques/service.js";
import { getTrialBalance } from "../src/modules/trialBalance/service.js";
import { getProfitAndLoss } from "../src/modules/profitAndLoss/service.js";
import { getCashFlow } from "../src/modules/cashFlow/service.js";

afterAll(async () => {
  await closePool();
});

function accountId(accounts: readonly AccountRow[], code: string): string {
  const account = accounts.find((a) => a.code === code);
  if (!account) throw new Error(`Seeded chart of accounts is missing code ${code}`);
  return account.id;
}

describe.each([
  { label: "VAT-registered tenant", vatRegistered: true },
  { label: "non-VAT tenant", vatRegistered: false },
])("full lifecycle: register through reports ($label)", ({ vatRegistered }) => {
  it("registers, records a credit sale/cash sale/bill/cheque, and reports them correctly", async () => {
    // --- 1. Register -- the app's onboarding screen -------------------
    const externalIdpSubject = `auth0|${randomUUID()}`;
    const { tenant, user, accounts } = await onboard({
      tenantName: vatRegistered ? "VAT Test Kiosk" : "No-VAT Test Kiosk",
      tenantType: "BUSINESS",
      baseCurrency: "KES",
      externalIdpSubject,
      userName: "Test Owner",
      vatRegistered,
      periodStartDate: "2026-09-01",
    });

    expect(tenant.vat_registered).toBe(vatRegistered);
    expect(user.tenant_id).toBe(tenant.id);
    // Starter chart of accounts (incl. 3900 Opening Balance Equity), +2 VAT accounts (1200, 2100) only when VAT-registered.
    expect(accounts).toHaveLength(vatRegistered ? 12 : 10);

    const audit: AuditContext = { actorUserId: user.id };
    const cash = accountId(accounts, "1000");
    const bank = accountId(accounts, "1010");
    const receivable = accountId(accounts, "1100");
    const payable = accountId(accounts, "2000");
    const sales = accountId(accounts, "4000");
    const purchases = accountId(accounts, "5000");
    const generalExpenses = accountId(accounts, "5100");
    const vatRecoverable = vatRegistered ? accountId(accounts, "1200") : undefined;
    const vatPayable = vatRegistered ? accountId(accounts, "2100") : undefined;

    // --- 2. Add a customer and a supplier -- the app's People screens --
    const customer = await customersService.createCustomer({ tenantId: tenant.id, name: "Jane Trader" }, audit);
    const supplier = await suppliersService.createSupplier({ tenantId: tenant.id, name: "Acme Supplies" }, audit);

    // --- 3. Credit sale: Dr AR / Cr Sales (+ Cr VAT Payable if registered) ---
    const creditSaleTaxMinor = vatRegistered ? 16000 : 0; // 16% of 100000
    await createCreditSale(
      {
        tenantId: tenant.id,
        clientUuid: randomUUID(),
        customerId: customer.id,
        receivableAccountId: receivable,
        date: "2026-09-05",
        currency: "KES",
        lines: [{ incomeAccountId: sales, amountMinor: 100000, narrative: "Goods sold on credit" }],
        ...(vatRegistered ? { taxAccountId: vatPayable, taxAmountMinor: creditSaleTaxMinor } : {}),
      },
      audit,
    );

    // --- 4. Cash sale: Dr Cash / Cr Sales (+ Cr VAT Payable if registered) ---
    const cashSaleTaxMinor = vatRegistered ? 8000 : 0; // 16% of 50000
    await createCashSale(
      {
        tenantId: tenant.id,
        clientUuid: randomUUID(),
        receivedAccountId: cash,
        date: "2026-09-06",
        currency: "KES",
        lines: [{ incomeAccountId: sales, amountMinor: 50000, narrative: "Goods sold for cash" }],
        ...(vatRegistered ? { taxAccountId: vatPayable, taxAmountMinor: cashSaleTaxMinor } : {}),
      },
      audit,
    );

    // --- 5. Bill: Dr Purchases (+ Dr VAT Recoverable if registered) / Cr AP ---
    const billTaxMinor = vatRegistered ? 6400 : 0; // 16% of 40000
    await createWriteBill(
      {
        tenantId: tenant.id,
        clientUuid: randomUUID(),
        supplierId: supplier.id,
        payableAccountId: payable,
        date: "2026-09-07",
        currency: "KES",
        lines: [{ expenseAccountId: purchases, amountMinor: 40000, narrative: "Stock purchased on credit" }],
        ...(vatRegistered ? { taxAccountId: vatRecoverable, taxAmountMinor: billTaxMinor } : {}),
      },
      audit,
    );

    // --- 6. Cheque: part-pays the bill's AP, plus a direct expense --------
    // Dr AP (supplier-tagged), Dr General Expenses / Cr Bank.
    await createWriteCheque(
      {
        tenantId: tenant.id,
        clientUuid: randomUUID(),
        bankAccountId: bank,
        date: "2026-09-10",
        currency: "KES",
        reference: "CHQ-0001",
        lines: [
          { accountId: payable, amountMinor: 20000, supplierId: supplier.id, narrative: "Part-payment of bill" },
          { accountId: generalExpenses, amountMinor: 5000, narrative: "Office supplies" },
        ],
      },
      audit,
    );

    // --- 7. Trial Balance: every journal above must still net to zero -----
    const trialBalance = await getTrialBalance(tenant.id);
    expect(trialBalance.isBalanced).toBe(true);
    expect(trialBalance.totalDebitMinor).toBe(trialBalance.totalCreditMinor);

    // --- 8. Profit & Loss: VAT lines sit on ASSET/LIABILITY accounts, never
    // INCOME/EXPENSE -- net profit must be identical whether VAT-registered
    // or not, even though the VAT-registered run posted extra tax lines.
    const pnl = await getProfitAndLoss(tenant.id, "2026-09-01", "2026-09-30");
    expect(pnl.totalIncomeMinor).toBe(150000); // 100000 (credit sale) + 50000 (cash sale), net of tax either way
    expect(pnl.totalExpenseMinor).toBe(45000); // 40000 (bill) + 5000 (cheque's direct expense line); VAT Recoverable is an ASSET, excluded
    expect(pnl.netProfitMinor).toBe(105000);

    // --- 9. Cash Flow: Cash only saw the cash-sale inflow, Bank only saw
    // the cheque's outflow -- proves the two accounts are reported
    // independently, and their totals sum correctly.
    const cashFlow = await getCashFlow(tenant.id, [cash, bank], "2026-09-01", "2026-09-30");
    const cashLine = cashFlow.accounts.find((a) => a.accountId === cash)!;
    const bankLine = cashFlow.accounts.find((a) => a.accountId === bank)!;
    expect(cashLine.inflowMinor).toBe(50000 + cashSaleTaxMinor);
    expect(cashLine.outflowMinor).toBe(0);
    expect(bankLine.outflowMinor).toBe(25000); // 20000 (AP part-payment) + 5000 (direct expense)
    expect(bankLine.inflowMinor).toBe(0);
    expect(cashFlow.netCashFlowMinor).toBe(cashLine.netMinor + bankLine.netMinor);
    expect(cashFlow.totalClosingBalanceMinor).toBe(cashLine.closingBalanceMinor + bankLine.closingBalanceMinor);

    // --- 10. Customer/Supplier subledgers -----------------------------
    // AR = the credit sale's gross; AP = the bill's gross minus the
    // cheque's 20000 part-payment.
    const customerAfter = await customersService.getCustomer(tenant.id, customer.id, "2026-09-30");
    const supplierAfter = await suppliersService.getSupplier(tenant.id, supplier.id, "2026-09-30");
    expect(customerAfter.balance_minor).toBe(String(100000 + creditSaleTaxMinor));
    expect(supplierAfter.balance_minor).toBe(String(40000 + billTaxMinor - 20000));
  });
});
