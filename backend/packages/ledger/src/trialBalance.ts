/**
 * Trial balance.
 *
 * SRS FR-TB-01: produced on demand and for any closed period, with drill-down
 * from balance to journal to source document. Glossary: "A listing of all
 * account balances, which must sum to zero under double entry."
 */

import { naturalSide, type AccountType, type CurrencyCode, type Uuid } from "@jibuks/domain";

export interface LedgerEntry {
  readonly accountId: Uuid;
  readonly debitMinor: number;
  readonly creditMinor: number;
}

export interface TrialBalanceRow {
  readonly accountId: Uuid;
  readonly accountCode: string;
  readonly accountName: string;
  readonly accountType: AccountType;
  readonly debitMinor: number;
  readonly creditMinor: number;
  /** Net presented on the account's natural side. */
  readonly balanceMinor: number;
}

export interface TrialBalance {
  readonly currency: CurrencyCode;
  readonly rows: readonly TrialBalanceRow[];
  readonly totalDebitMinor: number;
  readonly totalCreditMinor: number;
  readonly isBalanced: boolean;
}

export interface AccountRef {
  readonly id: Uuid;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
}

export function buildTrialBalance(
  entries: readonly LedgerEntry[],
  accounts: ReadonlyMap<Uuid, AccountRef>,
  currency: CurrencyCode,
): TrialBalance {
  const totals = new Map<Uuid, { debit: number; credit: number }>();

  for (const entry of entries) {
    const running = totals.get(entry.accountId) ?? { debit: 0, credit: 0 };
    running.debit += entry.debitMinor;
    running.credit += entry.creditMinor;
    totals.set(entry.accountId, running);
  }

  const rows: TrialBalanceRow[] = [];
  let totalDebit = 0;
  let totalCredit = 0;

  for (const [accountId, { debit, credit }] of totals) {
    const account = accounts.get(accountId);
    if (!account) continue;
    const net = naturalSide(account.type) === "DEBIT" ? debit - credit : credit - debit;
    rows.push({
      accountId,
      accountCode: account.code,
      accountName: account.name,
      accountType: account.type,
      debitMinor: debit,
      creditMinor: credit,
      balanceMinor: net,
    });
    totalDebit += debit;
    totalCredit += credit;
  }

  rows.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  return {
    currency,
    rows,
    totalDebitMinor: totalDebit,
    totalCreditMinor: totalCredit,
    isBalanced: totalDebit === totalCredit,
  };
}