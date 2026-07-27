/**
 * Chart of accounts.
 * SRS: FR-COA-01 (hierarchical, five classifications), FR-COA-03
 * (posted-to accounts are deactivated, never deleted), FR-COA-04 (tags).
 */

export const ACCOUNT_TYPES = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/**
 * Which side increases the account. Assets and expenses are debit-natured;
 * liabilities, equity and income are credit-natured. Used for presentation
 * and for the trial balance, never to relax the double-entry rule.
 */
export function naturalSide(type: AccountType): "DEBIT" | "CREDIT" {
  return type === "ASSET" || type === "EXPENSE" ? "DEBIT" : "CREDIT";
}

/** Accounts that appear on the Profit & Loss rather than the Balance Sheet. */
export function isProfitAndLoss(type: AccountType): boolean {
  return type === "INCOME" || type === "EXPENSE";
}