/**
 * Tests for trialBalance.ts.
 * FR-TB-01: a trial balance on demand. Glossary: "must sum to zero under
 * double entry" -- proven here via isBalanced.
 */

import { describe, expect, it } from "vitest";
import { buildTrialBalance, type AccountRef, type LedgerEntry } from "../src/index.js";

const CASH = "660e8400-e29b-41d4-a716-446655440001";
const SALES = "770e8400-e29b-41d4-a716-446655440002";
const RENT_EXPENSE = "880e8400-e29b-41d4-a716-446655440003";
const LOAN_PAYABLE = "990e8400-e29b-41d4-a716-446655440004";

function accounts(): Map<string, AccountRef> {
  return new Map([
    [CASH, { id: CASH, code: "1000", name: "Cash", type: "ASSET" }],
    [SALES, { id: SALES, code: "4000", name: "Sales Revenue", type: "INCOME" }],
    [RENT_EXPENSE, { id: RENT_EXPENSE, code: "5200", name: "Rent and Utilities", type: "EXPENSE" }],
    [LOAN_PAYABLE, { id: LOAN_PAYABLE, code: "2400", name: "Loans Payable", type: "LIABILITY" }],
  ]);
}

describe("buildTrialBalance -- happy path", () => {
  it("balances a simple two-account journal", () => {
    const entries: LedgerEntry[] = [
      { accountId: CASH, debitMinor: 1000, creditMinor: 0 },
      { accountId: SALES, debitMinor: 0, creditMinor: 1000 },
    ];
    const tb = buildTrialBalance(entries, accounts(), "KES");
    expect(tb.isBalanced).toBe(true);
    expect(tb.totalDebitMinor).toBe(1000);
    expect(tb.totalCreditMinor).toBe(1000);
  });

  it("nets multiple entries against the same account", () => {
    const entries: LedgerEntry[] = [
      { accountId: CASH, debitMinor: 700, creditMinor: 0 },
      { accountId: CASH, debitMinor: 300, creditMinor: 0 },
      { accountId: SALES, debitMinor: 0, creditMinor: 1000 },
    ];
    const tb = buildTrialBalance(entries, accounts(), "KES");
    const cashRow = tb.rows.find((r) => r.accountId === CASH)!;
    expect(cashRow.debitMinor).toBe(1000);
    expect(cashRow.creditMinor).toBe(0);
  });

  it("presents an asset account's balance on the debit (natural) side", () => {
    const entries: LedgerEntry[] = [
      { accountId: CASH, debitMinor: 1500, creditMinor: 500 },
    ];
    const tb = buildTrialBalance(entries, accounts(), "KES");
    const cashRow = tb.rows.find((r) => r.accountId === CASH)!;
    // ASSET is debit-natured: net = debit - credit
    expect(cashRow.balanceMinor).toBe(1000);
  });

  it("presents a liability account's balance on the credit (natural) side", () => {
    const entries: LedgerEntry[] = [
      { accountId: LOAN_PAYABLE, debitMinor: 200, creditMinor: 1200 },
    ];
    const tb = buildTrialBalance(entries, accounts(), "KES");
    const row = tb.rows.find((r) => r.accountId === LOAN_PAYABLE)!;
    // LIABILITY is credit-natured: net = credit - debit
    expect(row.balanceMinor).toBe(1000);
  });

  it("sorts rows by account code", () => {
    const entries: LedgerEntry[] = [
      { accountId: SALES, debitMinor: 0, creditMinor: 1000 },
      { accountId: CASH, debitMinor: 1000, creditMinor: 0 },
    ];
    const tb = buildTrialBalance(entries, accounts(), "KES");
    expect(tb.rows.map((r) => r.accountCode)).toEqual(["1000", "4000"]);
  });

  it("includes every account type across a realistic multi-line journal", () => {
    const entries: LedgerEntry[] = [
      { accountId: RENT_EXPENSE, debitMinor: 500, creditMinor: 0 },
      { accountId: CASH, debitMinor: 0, creditMinor: 500 },
      { accountId: CASH, debitMinor: 2000, creditMinor: 0 },
      { accountId: SALES, debitMinor: 0, creditMinor: 2000 },
    ];
    const tb = buildTrialBalance(entries, accounts(), "KES");
    expect(tb.isBalanced).toBe(true);
    expect(tb.rows).toHaveLength(3);
  });
});

describe("buildTrialBalance -- edge cases", () => {
  it("returns an empty, balanced trial balance for no entries", () => {
    const tb = buildTrialBalance([], accounts(), "KES");
    expect(tb.rows).toEqual([]);
    expect(tb.isBalanced).toBe(true);
    expect(tb.totalDebitMinor).toBe(0);
  });

  it("skips entries referencing an account not in the accounts map", () => {
    const unknownAccount = "aa0e8400-e29b-41d4-a716-446655440099";
    const entries: LedgerEntry[] = [
      { accountId: unknownAccount, debitMinor: 500, creditMinor: 0 },
      { accountId: CASH, debitMinor: 0, creditMinor: 500 },
    ];
    const tb = buildTrialBalance(entries, accounts(), "KES");
    // the unknown account contributes to nothing -- absent from rows and totals
    expect(tb.rows.find((r) => r.accountId === unknownAccount)).toBeUndefined();
    expect(tb.rows).toHaveLength(1);
  });

  it("reports isBalanced as false if totals genuinely diverge", () => {
    // Constructed directly to prove the honesty of isBalanced;
    // validateForPosting is what prevents this from happening in practice.
    const entries: LedgerEntry[] = [{ accountId: CASH, debitMinor: 1000, creditMinor: 0 }];
    const tb = buildTrialBalance(entries, accounts(), "KES");
    expect(tb.isBalanced).toBe(false);
    expect(tb.totalDebitMinor).toBe(1000);
    expect(tb.totalCreditMinor).toBe(0);
  });

  it("carries the requested currency through even with no entries", () => {
    const tb = buildTrialBalance([], accounts(), "UGX");
    expect(tb.currency).toBe("UGX");
  });
});