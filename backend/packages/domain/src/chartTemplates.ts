/**
 * Chart-of-accounts templates offered at onboarding (FR-COA-02, SRS
 * Appendix A). Shared with the clients (C-01) so the sign-up screen can show
 * exactly what each template seeds.
 *
 * GENERAL is the original JiBUks starter set, used when a client doesn't
 * choose. The other four follow Appendix A's codes and names, with these
 * additions the SRS lists don't cover:
 *   - 3900 Opening Balance Equity in every template, for the opening
 *     journal (FR-ACC-04);
 *   - VAT Recoverable (input VAT) and, where missing, VAT Payable for a
 *     VAT-registered business;
 *   - 1030 "Money Owed to Me" for micro-traders, so they can sell on credit
 *     and invoice;
 *   - 1020 (M-Pesa) tagged as the account M-Pesa collections land in.
 *
 * systemKey marks accounts the server finds by purpose rather than code:
 * codes clash between templates (1200 is VAT Recoverable in GENERAL but
 * Inventory in SME_TRADING) and tenants can recode accounts. Not every
 * template has every key -- NGO, CORPORATE and MICRO_TRADER have no
 * separate bank account.
 */

import type { AccountType } from "./accounts.js";

export const CHART_TEMPLATE_KEYS = ["GENERAL", "SME_TRADING", "NGO", "CORPORATE", "MICRO_TRADER"] as const;
export type ChartTemplateKey = (typeof CHART_TEMPLATE_KEYS)[number];

export const SYSTEM_ACCOUNT_KEYS = [
  "MPESA",
  "OPENING_BALANCE",
  "RECEIVABLE",
  "PAYABLE",
  "VAT_INPUT",
  "VAT_OUTPUT",
  "CASH",
  "BANK",
] as const;
export type SystemAccountKey = (typeof SYSTEM_ACCOUNT_KEYS)[number];

/**
 * Keys an Owner may move to another account with PATCH /accounts/{id}, e.g.
 * when they renamed or recoded their Accounts Receivable before keys
 * existed. MPESA and OPENING_BALANCE stay where the server put them.
 */
export const ASSIGNABLE_SYSTEM_ACCOUNT_KEYS = ["RECEIVABLE", "PAYABLE", "VAT_INPUT", "VAT_OUTPUT", "CASH", "BANK"] as const;
export type AssignableSystemAccountKey = (typeof ASSIGNABLE_SYSTEM_ACCOUNT_KEYS)[number];

/** The account type each key's account must have. */
export const SYSTEM_ACCOUNT_TYPES: Readonly<Record<SystemAccountKey, AccountType>> = {
  MPESA: "ASSET",
  OPENING_BALANCE: "EQUITY",
  RECEIVABLE: "ASSET",
  PAYABLE: "LIABILITY",
  VAT_INPUT: "ASSET",
  VAT_OUTPUT: "LIABILITY",
  CASH: "ASSET",
  BANK: "ASSET",
};

export interface TemplateAccount {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly systemKey?: SystemAccountKey;
  /** Only seeded for a VAT-registered business. */
  readonly vatOnly?: boolean;
}

export interface ChartTemplate {
  readonly key: ChartTemplateKey;
  readonly name: string;
  readonly description: string;
  readonly accounts: readonly TemplateAccount[];
}

const OPENING_BALANCE_EQUITY: TemplateAccount = {
  code: "3900",
  name: "Opening Balance Equity",
  type: "EQUITY",
  systemKey: "OPENING_BALANCE",
};

export const CHART_TEMPLATES: Readonly<Record<ChartTemplateKey, ChartTemplate>> = {
  GENERAL: {
    key: "GENERAL",
    name: "General starter",
    description: "A short starter chart: cash, bank, M-Pesa, receivables, payables, sales and expenses.",
    accounts: [
      { code: "1000", name: "Cash", type: "ASSET", systemKey: "CASH" },
      { code: "1010", name: "Bank", type: "ASSET", systemKey: "BANK" },
      { code: "1020", name: "M-Pesa", type: "ASSET", systemKey: "MPESA" },
      { code: "1100", name: "Accounts Receivable", type: "ASSET", systemKey: "RECEIVABLE" },
      { code: "1200", name: "VAT Recoverable (Input VAT)", type: "ASSET", systemKey: "VAT_INPUT", vatOnly: true },
      { code: "2000", name: "Accounts Payable", type: "LIABILITY", systemKey: "PAYABLE" },
      { code: "2100", name: "VAT Payable (Output VAT)", type: "LIABILITY", systemKey: "VAT_OUTPUT", vatOnly: true },
      { code: "3000", name: "Owner's Equity", type: "EQUITY" },
      OPENING_BALANCE_EQUITY,
      { code: "4000", name: "Sales Revenue", type: "INCOME" },
      { code: "5000", name: "Purchases", type: "EXPENSE" },
      { code: "5100", name: "General Expenses", type: "EXPENSE" },
    ],
  },
  SME_TRADING: {
    key: "SME_TRADING",
    name: "SME trading",
    description: "For shops, wholesalers and other trading businesses (SRS Appendix A.1).",
    accounts: [
      { code: "1000", name: "Cash on Hand", type: "ASSET", systemKey: "CASH" },
      { code: "1010", name: "Bank Accounts", type: "ASSET", systemKey: "BANK" },
      { code: "1020", name: "Mobile Money Wallets", type: "ASSET", systemKey: "MPESA" },
      { code: "1030", name: "Accounts Receivable", type: "ASSET", systemKey: "RECEIVABLE" },
      { code: "1200", name: "Inventory", type: "ASSET" },
      { code: "1250", name: "VAT Recoverable (Input VAT)", type: "ASSET", systemKey: "VAT_INPUT", vatOnly: true },
      { code: "1500", name: "Prepaid Expenses", type: "ASSET" },
      { code: "1700", name: "Fixed Assets", type: "ASSET" },
      { code: "1799", name: "Accumulated Depreciation", type: "ASSET" },
      { code: "2000", name: "Accounts Payable", type: "LIABILITY", systemKey: "PAYABLE" },
      { code: "2100", name: "Accrued Expenses", type: "LIABILITY" },
      { code: "2200", name: "VAT Payable", type: "LIABILITY", systemKey: "VAT_OUTPUT", vatOnly: true },
      { code: "2210", name: "Withholding Tax Payable", type: "LIABILITY" },
      { code: "2400", name: "Loans Payable", type: "LIABILITY" },
      { code: "3000", name: "Owner's Capital", type: "EQUITY" },
      { code: "3100", name: "Retained Earnings", type: "EQUITY" },
      OPENING_BALANCE_EQUITY,
      { code: "4000", name: "Sales Revenue", type: "INCOME" },
      { code: "4100", name: "Other Income", type: "INCOME" },
      { code: "5000", name: "Cost of Goods Sold", type: "EXPENSE" },
      { code: "5100", name: "Salaries and Wages", type: "EXPENSE" },
      { code: "5200", name: "Rent and Utilities", type: "EXPENSE" },
      { code: "5300", name: "Marketing and Advertising", type: "EXPENSE" },
      { code: "5400", name: "Depreciation", type: "EXPENSE" },
      { code: "5500", name: "Transport", type: "EXPENSE" },
      { code: "5600", name: "Mobile Money and Bank Charges", type: "EXPENSE" },
      { code: "5900", name: "Miscellaneous Expenses", type: "EXPENSE" },
    ],
  },
  NGO: {
    key: "NGO",
    name: "NGO and donor-funded",
    description: "Restricted and unrestricted funds, grants and programme costs (SRS Appendix A.2).",
    accounts: [
      { code: "1000", name: "Cash Unrestricted", type: "ASSET", systemKey: "CASH" },
      { code: "1010", name: "Cash Restricted", type: "ASSET" },
      { code: "1100", name: "Grants Receivable", type: "ASSET", systemKey: "RECEIVABLE" },
      { code: "1250", name: "VAT Recoverable (Input VAT)", type: "ASSET", systemKey: "VAT_INPUT", vatOnly: true },
      { code: "1300", name: "Prepaid Expenses", type: "ASSET" },
      { code: "2000", name: "Accounts Payable", type: "LIABILITY", systemKey: "PAYABLE" },
      { code: "2100", name: "Accrued Expenses", type: "LIABILITY" },
      { code: "2200", name: "VAT Payable", type: "LIABILITY", systemKey: "VAT_OUTPUT", vatOnly: true },
      { code: "2300", name: "Deferred Grant Income", type: "LIABILITY" },
      { code: "3000", name: "Unrestricted Fund Balance", type: "EQUITY" },
      { code: "3100", name: "Restricted Fund Balance", type: "EQUITY" },
      OPENING_BALANCE_EQUITY,
      { code: "4000", name: "Grant Income", type: "INCOME" },
      { code: "4100", name: "Donation Income", type: "INCOME" },
      { code: "4200", name: "Project-Specific Funding", type: "INCOME" },
      { code: "5000", name: "Programme Expenses", type: "EXPENSE" },
      { code: "5100", name: "Administrative Costs", type: "EXPENSE" },
      { code: "5200", name: "Fundraising Costs", type: "EXPENSE" },
      { code: "5300", name: "Monitoring and Evaluation", type: "EXPENSE" },
    ],
  },
  CORPORATE: {
    key: "CORPORATE",
    name: "Corporate",
    description: "Companies with share capital, investments and financing (SRS Appendix A.3).",
    accounts: [
      { code: "1000", name: "Cash and Cash Equivalents", type: "ASSET", systemKey: "CASH" },
      { code: "1100", name: "Accounts Receivable", type: "ASSET", systemKey: "RECEIVABLE" },
      { code: "1200", name: "Inventory", type: "ASSET" },
      { code: "1250", name: "VAT Recoverable (Input VAT)", type: "ASSET", systemKey: "VAT_INPUT", vatOnly: true },
      { code: "1500", name: "Property, Plant and Equipment", type: "ASSET" },
      { code: "1700", name: "Investments", type: "ASSET" },
      { code: "2000", name: "Accounts Payable", type: "LIABILITY", systemKey: "PAYABLE" },
      { code: "2100", name: "Notes and Bonds Payable", type: "LIABILITY" },
      { code: "2200", name: "Lease Obligations", type: "LIABILITY" },
      { code: "2500", name: "Tax Liabilities", type: "LIABILITY" },
      { code: "2510", name: "VAT Payable", type: "LIABILITY", systemKey: "VAT_OUTPUT", vatOnly: true },
      { code: "3000", name: "Share Capital", type: "EQUITY" },
      { code: "3100", name: "Retained Earnings", type: "EQUITY" },
      { code: "3200", name: "Reserves", type: "EQUITY" },
      OPENING_BALANCE_EQUITY,
      { code: "4000", name: "Revenue", type: "INCOME" },
      { code: "4100", name: "Dividend Income", type: "INCOME" },
      { code: "5000", name: "Cost of Sales", type: "EXPENSE" },
      { code: "5100", name: "Operating Expenses", type: "EXPENSE" },
      { code: "5200", name: "Research and Development", type: "EXPENSE" },
      { code: "5300", name: "Finance Costs", type: "EXPENSE" },
      { code: "5400", name: "Depreciation and Amortisation", type: "EXPENSE" },
    ],
  },
  MICRO_TRADER: {
    key: "MICRO_TRADER",
    name: "Micro-trader",
    description: "Plain-language accounts for a small shop or kiosk (SRS Appendix A.4). Codes are never shown.",
    accounts: [
      { code: "1000", name: "Cash", type: "ASSET", systemKey: "CASH" },
      { code: "1020", name: "M-Pesa / Airtel", type: "ASSET", systemKey: "MPESA" },
      { code: "1030", name: "Money Owed to Me", type: "ASSET", systemKey: "RECEIVABLE" },
      { code: "1200", name: "Stock", type: "ASSET" },
      { code: "1250", name: "VAT I Can Claim Back", type: "ASSET", systemKey: "VAT_INPUT", vatOnly: true },
      { code: "2000", name: "Money I Owe", type: "LIABILITY", systemKey: "PAYABLE" },
      { code: "2200", name: "VAT I Owe", type: "LIABILITY", systemKey: "VAT_OUTPUT", vatOnly: true },
      { code: "3000", name: "My Money in the Business", type: "EQUITY" },
      { code: "3900", name: "Starting Balances", type: "EQUITY", systemKey: "OPENING_BALANCE" },
      { code: "4000", name: "Sales", type: "INCOME" },
      { code: "5000", name: "Cost of Goods", type: "EXPENSE" },
      { code: "5200", name: "Rent and Bills", type: "EXPENSE" },
      { code: "5500", name: "Transport", type: "EXPENSE" },
      { code: "5900", name: "Other Costs", type: "EXPENSE" },
    ],
  },
};

/** The accounts a template seeds for a business, VAT-registered or not. */
export function templateAccounts(key: ChartTemplateKey, vatRegistered: boolean): TemplateAccount[] {
  return CHART_TEMPLATES[key].accounts.filter((a) => vatRegistered || !a.vatOnly);
}
