/**
 * Zod validation schemas shared by mobile, web and server.
 *
 * SRS C-01: "request and response validation schemas" MUST be shared and
 * MUST NOT be reimplemented per surface. R-07 tracks divergence risk.
 * Section 5.2: "request validation with Zod shared with the clients".
 */

import { z } from "zod";
import { CURRENCIES } from "./currency.js";
import { ACCOUNT_TYPES } from "./accounts.js";
import { JOURNAL_SOURCES } from "./journal.js";
import { PERMISSIONS, SYSTEM_ROLE_KEYS } from "./permissions.js";
import { ASSIGNABLE_SYSTEM_ACCOUNT_KEYS, CHART_TEMPLATE_KEYS } from "./chartTemplates.js";
import { BILL_KINDS, INVOICE_PAYMENT_METHODS, INVOICE_VIEW_STATUSES, SALES_KINDS, TAX_MODES } from "./invoices.js";

export const uuidSchema = z.string().uuid();

export const currencySchema = z.enum(
  Object.keys(CURRENCIES) as [keyof typeof CURRENCIES, ...(keyof typeof CURRENCIES)[]],
);

/** ISO 8601 calendar date, no time component (Section 9.1, Dates and times). */
export const accountingDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Accounting dates are calendar dates in YYYY-MM-DD form")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "Not a real calendar date");

/** Non-negative integer minor units. Floats are rejected at the boundary (C-07). */
export const minorUnitsSchema = z
  .number()
  .int("Monetary amounts are integer minor units, not decimals")
  .nonnegative()
  .safe();

export const accountTypeSchema = z.enum(ACCOUNT_TYPES);

/** Query params for GET /accounts, GET /customers, GET /suppliers and their
 * /{id} counterparts: an optional point-in-time cutoff for the returned
 * balance_minor (Section 9.1 dates). `as_of` (not camelCase) because it's a
 * query string, not a JSON body. */
export const partyBalanceQuerySchema = z.object({
  as_of: accountingDateSchema.optional(),
});

export type PartyBalanceQueryDto = z.infer<typeof partyBalanceQuerySchema>;

export const journalLineSchema = z
  .object({
    accountId: uuidSchema,
    debitMinor: minorUnitsSchema.default(0),
    creditMinor: minorUnitsSchema.default(0),
    narrative: z.string().max(500).optional(),
    projectId: uuidSchema.optional(),
    department: z.string().max(100).optional(),
    /** Optional attribution to a customer/supplier subledger (mutually
     * exclusive) -- see packages/server/src/modules/{customers,suppliers}. */
    customerId: uuidSchema.optional(),
    supplierId: uuidSchema.optional(),
  })
  .refine((l) => !(l.debitMinor > 0 && l.creditMinor > 0), {
    message: "A line carries either a debit or a credit, never both",
    path: ["debitMinor"],
  })
  .refine((l) => l.debitMinor > 0 || l.creditMinor > 0, {
    message: "A line must carry a non-zero debit or credit",
    path: ["debitMinor"],
  })
  .refine((l) => !(l.customerId && l.supplierId), {
    message: "A line carries either a customer or a supplier, never both",
    path: ["customerId"],
  });

export const journalInputSchema = z.object({
  clientUuid: uuidSchema,
  branchId: uuidSchema.optional(),
  date: accountingDateSchema,
  currency: currencySchema,
  description: z.string().min(1).max(500),
  reference: z.string().max(100).optional(),
  source: z.enum(JOURNAL_SOURCES).default("MANUAL"),
  lines: z.array(journalLineSchema).min(2, "A journal needs at least two lines to balance"),
});

/** Request body shape for creating a journal via HTTP -- tenantId is
 * deliberately absent, since it comes from the authenticated request
 * context (req.tenantId), never from client-supplied body data. */
export const createJournalRequestSchema = z.object({
  clientUuid: uuidSchema,
  branchId: uuidSchema.optional(),
  date: accountingDateSchema,
  currency: currencySchema,
  description: z.string().min(1).max(500),
  reference: z.string().max(100).optional(),
  source: z.enum(JOURNAL_SOURCES).default("MANUAL"),
  lines: z.array(journalLineSchema).min(2, "A journal needs at least two lines to balance"),
});

export type CreateJournalRequestDto = z.infer<typeof createJournalRequestSchema>;

export const createAccountSchema = z.object({
  clientUuid: uuidSchema.optional(),
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(200),
  type: accountTypeSchema,
  parentAccountId: uuidSchema.nullable().optional(),
  currency: currencySchema.optional(),
  tags: z.array(z.string().max(50)).max(20).default([]),
});

/** PATCH /accounts/{id} (FR-COA-03/04): rename, recode, retag or re-parent.
 * Type and currency are fixed once an account exists. null parent = top level. */
export const updateAccountSchema = z
  .object({
    code: z.string().trim().min(1).max(20).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    tags: z.array(z.string().max(50)).max(20).optional(),
    parentAccountId: uuidSchema.nullable().optional(),
    /** Make this the business's account for that purpose (RECEIVABLE, PAYABLE, VAT_INPUT, VAT_OUTPUT, CASH, BANK). */
    systemKey: z.enum(ASSIGNABLE_SYSTEM_ACCOUNT_KEYS).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Provide at least one field to update");

export type UpdateAccountDto = z.infer<typeof updateAccountSchema>;

/**
 * Tax identifier (FR-AP-01), e.g. a Kenyan KRA PIN such as "P051234567X".
 * Deliberately not KRA-specific -- tenants also trade in UGX/RWF etc, where
 * the identifier format differs. Trimmed and upper-cased so the same PIN
 * typed two ways compares equal.
 */
export const taxIdentifierSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(
    z
      .string()
      .min(1)
      .max(50)
      .regex(/^[A-Z0-9][A-Z0-9 /-]*$/, "Letters, digits, spaces, '-' and '/' only"),
  );

/** Net payment terms in days (0 = due on receipt). */
export const paymentTermsDaysSchema = z.number().int().min(0).max(365);

/** Shared shape of a customer/supplier -- a name list, deliberately separate
 * from createAccountSchema (no code, no type, no parent hierarchy). */
const partyFields = {
  name: z.string().min(1).max(200),
  phone: z.string().max(20).optional(),
  email: z.string().email().optional(),
  address: z.string().max(500).optional(),
  tags: z.array(z.string().max(50)).max(20).default([]),
  taxIdentifier: taxIdentifierSchema.optional(),
  paymentTermsDays: paymentTermsDaysSchema.optional(),
  /** Omit for the tenant's base currency (same convention as accounts). */
  currency: currencySchema.optional(),
};

export const createSupplierSchema = z.object(partyFields);

export const createCustomerSchema = z.object({
  ...partyFields,
  /** In the customer's currency, integer minor units. Omit for no limit. */
  creditLimitMinor: minorUnitsSchema.optional(),
});

export type CreateCustomerDto = z.infer<typeof createCustomerSchema>;
export type CreateSupplierDto = z.infer<typeof createSupplierSchema>;

/** PATCH semantics: omitted fields are unchanged; null clears an optional one. */
const updatePartyFields = {
  name: partyFields.name.optional(),
  phone: z.string().max(20).nullable().optional(),
  email: z.string().email().nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  taxIdentifier: taxIdentifierSchema.nullable().optional(),
  paymentTermsDays: paymentTermsDaysSchema.nullable().optional(),
  currency: currencySchema.nullable().optional(),
};

const atLeastOneField = (body: object) => Object.keys(body).length > 0;

export const updateSupplierSchema = z
  .object(updatePartyFields)
  .refine(atLeastOneField, "Provide at least one field to update");

export const updateCustomerSchema = z
  .object({ ...updatePartyFields, creditLimitMinor: minorUnitsSchema.nullable().optional() })
  .refine(atLeastOneField, "Provide at least one field to update");

export type UpdateCustomerDto = z.infer<typeof updateCustomerSchema>;
export type UpdateSupplierDto = z.infer<typeof updateSupplierSchema>;

/**
 * Shared revenue-line shape for both guided sale endpoints below: one
 * income account plus the net (pre-tax) amount for that line.
 */
const saleLineSchema = z
  .object({
    incomeAccountId: uuidSchema,
    amountMinor: minorUnitsSchema,
    narrative: z.string().max(500).optional(),
  })
  .refine((l) => l.amountMinor > 0, {
    message: "A sale line amount must be greater than zero",
    path: ["amountMinor"],
  });

/**
 * Guided Credit Sale (the Sales Day Book entry of manual bookkeeping):
 *   Dr Accounts Receivable (gross, tagged to the customer)
 *     Cr Revenue line(s) (net)
 *     Cr Tax Payable (VAT/sales tax, if any)
 * The client supplies the invoice shape; the server computes the AR total
 * and builds the balanced journal -- see packages/server/src/modules/creditSales.
 */
export const createCreditSaleSchema = z
  .object({
    clientUuid: uuidSchema,
    branchId: uuidSchema.optional(),
    customerId: uuidSchema,
    receivableAccountId: uuidSchema,
    date: accountingDateSchema,
    currency: currencySchema,
    reference: z.string().max(100).optional(),
    description: z.string().max(500).optional(),
    lines: z.array(saleLineSchema).min(1, "A credit sale needs at least one revenue line"),
    /** Tax (e.g. Kenyan VAT) is a single credit against one tax account --
     * multiple tax rates in one sale would need multiple lines, not
     * modelled here in this first cut. */
    taxAccountId: uuidSchema.optional(),
    taxAmountMinor: minorUnitsSchema.default(0),
  })
  .refine((r) => r.taxAmountMinor === 0 || r.taxAccountId !== undefined, {
    message: "taxAccountId is required when taxAmountMinor is greater than zero",
    path: ["taxAccountId"],
  });

export type CreateCreditSaleDto = z.infer<typeof createCreditSaleSchema>;

/**
 * Guided Cash Sale (the Cash Receipts Book entry of manual bookkeeping) --
 * payment is received immediately, so there is no customer/AR involved at
 * all, unlike Credit Sale:
 *   Dr Cash/Bank (gross)
 *     Cr Revenue line(s) (net)
 *     Cr Tax Payable (VAT/sales tax, if any)
 * See packages/server/src/modules/cashSales.
 */
export const createCashSaleSchema = z
  .object({
    clientUuid: uuidSchema,
    branchId: uuidSchema.optional(),
    receivedAccountId: uuidSchema,
    date: accountingDateSchema,
    currency: currencySchema,
    reference: z.string().max(100).optional(),
    description: z.string().max(500).optional(),
    lines: z.array(saleLineSchema).min(1, "A cash sale needs at least one revenue line"),
    taxAccountId: uuidSchema.optional(),
    taxAmountMinor: minorUnitsSchema.default(0),
  })
  .refine((r) => r.taxAmountMinor === 0 || r.taxAccountId !== undefined, {
    message: "taxAccountId is required when taxAmountMinor is greater than zero",
    path: ["taxAccountId"],
  });

export type CreateCashSaleDto = z.infer<typeof createCashSaleSchema>;

/**
 * Guided Write Bill (the Purchases Day Book entry of manual bookkeeping) --
 * the supplier-side mirror of Credit Sale. Tax on a purchase is money the
 * business can reclaim (input VAT), so unlike a sale's tax line, it is a
 * DEBIT here, not a credit:
 *   Dr Expense/Asset line(s) (net)
 *   Dr Input Tax (if any)
 *     Cr Accounts Payable (gross, tagged to the supplier)
 * See packages/server/src/modules/bills.
 */
const billLineSchema = z
  .object({
    expenseAccountId: uuidSchema,
    amountMinor: minorUnitsSchema,
    narrative: z.string().max(500).optional(),
  })
  .refine((l) => l.amountMinor > 0, {
    message: "A bill line amount must be greater than zero",
    path: ["amountMinor"],
  });

export const createWriteBillSchema = z
  .object({
    clientUuid: uuidSchema,
    branchId: uuidSchema.optional(),
    supplierId: uuidSchema,
    payableAccountId: uuidSchema,
    date: accountingDateSchema,
    currency: currencySchema,
    reference: z.string().max(100).optional(),
    description: z.string().max(500).optional(),
    lines: z.array(billLineSchema).min(1, "A bill needs at least one expense line"),
    /** Input tax (e.g. Kenyan VAT) is a single debit against one recoverable
     * tax account -- multiple tax rates in one bill would need multiple
     * lines, not modelled here in this first cut. */
    taxAccountId: uuidSchema.optional(),
    taxAmountMinor: minorUnitsSchema.default(0),
  })
  .refine((r) => r.taxAmountMinor === 0 || r.taxAccountId !== undefined, {
    message: "taxAccountId is required when taxAmountMinor is greater than zero",
    path: ["taxAccountId"],
  });

export type CreateWriteBillDto = z.infer<typeof createWriteBillSchema>;

/**
 * Guided Write Cheque (the Cash Payments Book entry of manual bookkeeping)
 * -- a payment OUT, unlike the other three guided endpoints which each
 * record a new sale/purchase event. Its lines are naturally heterogeneous:
 * some may clear an existing supplier bill (accountId = AP, supplierId
 * set), others may pay an expense directly (no party at all) -- so, unlike
 * Credit Sale/Cash Sale/Write Bill, there is no single well-known "the
 * other side" account type; every line is just a debit against whatever
 * account the payment is for:
 *   Dr <line accountId>(s)  (whatever the cheque is paying for)
 *     Cr Bank                (gross)
 * See packages/server/src/modules/cheques.
 */
const writeChequeLineSchema = z
  .object({
    accountId: uuidSchema,
    amountMinor: minorUnitsSchema,
    narrative: z.string().max(500).optional(),
    /** Optional attribution to a customer/supplier subledger (mutually
     * exclusive) -- e.g. tag supplierId when this line clears part of
     * that supplier's outstanding bill. */
    customerId: uuidSchema.optional(),
    supplierId: uuidSchema.optional(),
  })
  .refine((l) => l.amountMinor > 0, {
    message: "A cheque line amount must be greater than zero",
    path: ["amountMinor"],
  })
  .refine((l) => !(l.customerId && l.supplierId), {
    message: "A line carries either a customer or a supplier, never both",
    path: ["customerId"],
  });

export const createWriteChequeSchema = z.object({
  clientUuid: uuidSchema,
  branchId: uuidSchema.optional(),
  bankAccountId: uuidSchema,
  date: accountingDateSchema,
  currency: currencySchema,
  reference: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
  lines: z.array(writeChequeLineSchema).min(1, "A cheque needs at least one line"),
});

export type CreateWriteChequeDto = z.infer<typeof createWriteChequeSchema>;

/**
 * Guided Cash Expense (the Cash Payments Book entry of manual bookkeeping)
 * -- the immediate-cash mirror of Write Bill: an expense paid on the spot,
 * with no Accounts Payable/supplier subledger involved at all:
 *   Dr Expense/Asset line(s) (net)
 *   Dr Input Tax (if any -- reclaimable, unlike a sale's tax credit)
 *     Cr Cash/Bank (gross)
 * Completes the micro-cashbook's "record a sale + record an expense" pair
 * alongside Cash Sale (FR-MIC-01). See packages/server/src/modules/cashExpenses.
 */
export const createCashExpenseSchema = z
  .object({
    clientUuid: uuidSchema,
    branchId: uuidSchema.optional(),
    paidAccountId: uuidSchema,
    date: accountingDateSchema,
    currency: currencySchema,
    reference: z.string().max(100).optional(),
    description: z.string().max(500).optional(),
    lines: z.array(billLineSchema).min(1, "A cash expense needs at least one expense line"),
    taxAccountId: uuidSchema.optional(),
    taxAmountMinor: minorUnitsSchema.default(0),
  })
  .refine((r) => r.taxAmountMinor === 0 || r.taxAccountId !== undefined, {
    message: "taxAccountId is required when taxAmountMinor is greater than zero",
    path: ["taxAccountId"],
  });

export type CreateCashExpenseDto = z.infer<typeof createCashExpenseSchema>;

/** Query params for GET /profit-and-loss (FR-RPT-01): a required date
 * range, unlike Trial Balance's single as_of cutoff -- P&L is only ever
 * meaningful "for a period", never cumulative since inception. */
export const profitAndLossQuerySchema = z
  .object({
    from: accountingDateSchema,
    to: accountingDateSchema,
  })
  .refine((r) => r.from <= r.to, {
    message: "from must be on or before to",
    path: ["to"],
  });

export type ProfitAndLossQueryDto = z.infer<typeof profitAndLossQuerySchema>;

/** Query params for GET /cash-flow (FR-RPT-01): one or more Cash/Bank
 * account ids plus a date range. Unlike Trial Balance/P&L, which discover
 * every account with ledger activity on their own, Cash Flow needs to be
 * told which account(s) count as cash/cash-equivalents -- the same
 * client-tells-the-server-which-account convention the guided endpoints
 * already use (e.g. Cash Sale's receivedAccountId), since accounts here
 * carry no is-cash-equivalent flag of their own. */
export const cashFlowQuerySchema = z
  .object({
    accountId: z.union([uuidSchema, z.array(uuidSchema).min(1)]),
    from: accountingDateSchema,
    to: accountingDateSchema,
  })
  .transform((r) => ({ ...r, accountId: Array.isArray(r.accountId) ? r.accountId : [r.accountId] }))
  .refine((r) => r.from <= r.to, {
    message: "from must be on or before to",
    path: ["to"],
  });

export type CashFlowQueryDto = z.infer<typeof cashFlowQuerySchema>;

export const createPeriodSchema = z.object({
  startDate: accountingDateSchema,
  endDate: accountingDateSchema,
});

export type CreatePeriodDto = z.infer<typeof createPeriodSchema>;

/** A role reference: a built-in role key ("CASHIER") or a custom role's id. */
export const roleRefSchema = z.union([z.enum(SYSTEM_ROLE_KEYS), uuidSchema]);

export const createUserSchema = z.object({
  externalIdpSubject: z.string().min(1).max(500),
  name: z.string().min(1).max(200),
  email: z.string().email().optional(),
  phone: z.string().max(20).optional(),
  /** Defaults to [DEFAULT_ROLE] (least privilege) when omitted. */
  roles: z.array(roleRefSchema).min(1).max(10).optional(),
});

export type CreateUserDto = z.infer<typeof createUserSchema>;

export const createInviteSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200).optional(),
  /** Role the invitee receives on accepting. Defaults to DEFAULT_ROLE. */
  role: roleRefSchema.optional(),
});

export const acceptInviteSchema = z.object({
  name: z.string().min(1).max(200),
});

export const onboardingRequestSchema = z.object({
  tenantName: z.string().min(1).max(200),
  tenantType: z.enum(["BUSINESS", "NGO", "HOUSEHOLD"]),
  baseCurrency: currencySchema,
  userName: z.string().min(1).max(200),
  email: z.string().email().optional(),
  phone: z.string().max(20).optional(),
  /** Whether this business charges VAT -- determines whether the starter
   * chart of accounts seeded by onboarding includes VAT Payable/VAT
   * Recoverable accounts, and lets the frontend decide whether to show tax
   * fields on the guided sale/bill screens at all. */
  vatRegistered: z.boolean(),
  /** The date this tenant's books begin. Onboarding seeds one OPEN period
   * running from this date through the end of that calendar month, so the
   * guided Credit Sale/Cash Sale/Write Bill/Write Cheque endpoints work
   * immediately after sign-up. */
  periodStartDate: accountingDateSchema,
  /** Which chart of accounts to seed (FR-COA-02). Omit for GENERAL, the
   * original starter set; see CHART_TEMPLATES for what each one contains. */
  chartTemplate: z.enum(CHART_TEMPLATE_KEYS).default("GENERAL"),
});

export type OnboardingRequestDto = z.infer<typeof onboardingRequestSchema>;

/** Cursor pagination (Section 9.1). Offset pagination is not used. */
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(500).optional(),
});

export type JournalInputDto = z.infer<typeof journalInputSchema>;
export type CreateAccountDto = z.infer<typeof createAccountSchema>;
export type PaginationDto = z.infer<typeof paginationSchema>;
// ---------------------------------------------------------------------
// Roles -- FR-RBAC-01/02
// ---------------------------------------------------------------------

const permissionListSchema = z
  .array(z.enum(PERMISSIONS))
  .min(1)
  .refine((list) => new Set(list).size === list.length, "Permissions must not repeat");

export const createRoleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).optional(),
  permissions: permissionListSchema,
});

export type CreateRoleDto = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().max(500).nullable().optional(),
    permissions: permissionListSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Provide at least one field to update");

export type UpdateRoleDto = z.infer<typeof updateRoleSchema>;

/** Replaces a user's full set of role assignments. */
export const setUserRolesSchema = z.object({
  roles: z
    .array(roleRefSchema)
    .min(1)
    .max(10)
    .refine((list) => new Set(list).size === list.length, "Roles must not repeat"),
});

export type SetUserRolesDto = z.infer<typeof setUserRolesSchema>;

// ---------------------------------------------------------------------
// Payments -- FR-PAY-01/06, IF-PAY-01
// ---------------------------------------------------------------------

/**
 * A Kenyan mobile number in any common form -- "0712345678",
 * "712345678", "+254712345678", "254712345678" (also 01xx numbers) --
 * normalised to the 2547XXXXXXXX / 2541XXXXXXXX form M-Pesa requires.
 */
export const kenyanMobileSchema = z
  .string()
  .transform((raw) => raw.replace(/[\s-]/g, ""))
  .pipe(
    z
      .string()
      .regex(/^(?:\+?254|0)?[17]\d{8}$/, "Must be a Kenyan mobile number, e.g. 0712345678 or +254712345678"),
  )
  .transform((digits) => `254${digits.slice(-9)}`);

/**
 * Initiate an M-Pesa STK push (Lipa na M-Pesa Online). On success the
 * money is posted as Dr receivedAccountId (default: the tenant's M-Pesa
 * account, created if missing) for the full amount, Cr taxAccountId for
 * taxAmountMinor (VAT included in the amount, if any) and the rest to /
 * Cr creditAccountId -- an income account for a cash-style sale, or
 * Accounts Receivable with customerId set when settling what a customer
 * owes.
 */
export const createStkPushSchema = z
  .object({
    /** Also the collection's identity: a retry with the same clientUuid never
     * triggers a second prompt (FR-PAY-06). */
    clientUuid: uuidSchema,
    phone: kenyanMobileSchema,
    /** KES only; M-Pesa collects whole shillings, so a multiple of 100. */
    currency: z.literal("KES"),
    amountMinor: minorUnitsSchema
      .refine((n) => n >= 100, "The minimum M-Pesa amount is KES 1")
      .refine((n) => n % 100 === 0, "M-Pesa collects whole shillings only (amountMinor must be a multiple of 100)")
      .refine((n) => n <= 25_000_000, "M-Pesa's per-transaction limit is KES 250,000"),
    receivedAccountId: uuidSchema.optional(),
    /** Required unless invoiceId is given (the invoice's receivable account is used). */
    creditAccountId: uuidSchema.optional(),
    customerId: uuidSchema.optional(),
    /** Collect against an issued invoice: on success the payment is applied
     * to it (FR-PAY-04). Its customer and receivable account are used, so
     * creditAccountId, customerId and tax must be left out. */
    invoiceId: uuidSchema.optional(),
    /** Shown on the customer's phone; M-Pesa truncates it to 12 characters. */
    accountReference: z.string().trim().min(1).max(12).optional(),
    description: z.string().max(500).optional(),
    /** Output VAT included in amountMinor -- same convention as Cash Sale. */
    taxAccountId: uuidSchema.optional(),
    taxAmountMinor: minorUnitsSchema.default(0),
  })
  .refine((r) => r.taxAmountMinor === 0 || r.taxAccountId !== undefined, {
    message: "taxAccountId is required when taxAmountMinor is greater than zero",
    path: ["taxAccountId"],
  })
  .refine((r) => r.taxAmountMinor < r.amountMinor, {
    message: "taxAmountMinor must be less than amountMinor (amountMinor is the gross amount, VAT included)",
    path: ["taxAmountMinor"],
  })
  .refine((r) => r.invoiceId !== undefined || r.creditAccountId !== undefined, {
    message: "creditAccountId is required unless invoiceId is given",
    path: ["creditAccountId"],
  })
  .refine(
    (r) =>
      r.invoiceId === undefined ||
      (r.creditAccountId === undefined && r.customerId === undefined && r.taxAmountMinor === 0 && r.taxAccountId === undefined),
    {
      message: "With invoiceId, leave out creditAccountId, customerId and tax -- they come from the invoice",
      path: ["invoiceId"],
    },
  );

export type CreateStkPushDto = z.infer<typeof createStkPushSchema>;

// ---------------------------------------------------------------------
// Invoices -- FR-AR-02/05, FR-TAX-01, FR-PAY-04
// ---------------------------------------------------------------------

const invoiceLineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  /** Up to three decimal places, e.g. 2.5 kg. */
  quantity: z
    .number()
    .positive()
    .max(99_999_999_999)
    .refine((q) => Math.abs(Math.round(q * 1000) - q * 1000) < 1e-6, "Quantity has at most three decimal places"),
  /** Before tax under EXCLUSIVE, tax included under INCLUSIVE. */
  unitPriceMinor: minorUnitsSchema,
  incomeAccountId: uuidSchema,
  /** Basis points: 1600 = 16% (Kenyan VAT). 0 = zero-rated / exempt line. */
  taxRateBps: z.number().int().min(0).max(10000).default(0),
  /** Output VAT account. Omit for the business's VAT_OUTPUT account. */
  taxAccountId: uuidSchema.optional(),
});

const invoiceLinesSchema = z.array(invoiceLineSchema).min(1, "An invoice needs at least one line").max(200);

/** Tax rules that need the whole document: NONE means no rates. A taxed line
 * without taxAccountId posts to the business's VAT_OUTPUT account. */
function checkInvoiceTax(
  body: { taxMode?: (typeof TAX_MODES)[number] | undefined; lines?: z.infer<typeof invoiceLinesSchema> | undefined },
  ctx: z.RefinementCtx,
): void {
  body.lines?.forEach((line, i) => {
    if (body.taxMode === "NONE" && line.taxRateBps > 0) {
      ctx.addIssue({ code: "custom", path: ["lines", i, "taxRateBps"], message: "taxMode NONE allows no tax rate" });
    }
  });
}

/** POST /invoices -- a DRAFT invoice or pro-forma. */
export const createInvoiceSchema = z
  .object({
    clientUuid: uuidSchema,
    kind: z.enum(["INVOICE", "PROFORMA"]).default("INVOICE"),
    branchId: uuidSchema.optional(),
    customerId: uuidSchema,
    /** Omit for the business's RECEIVABLE account (a pro-forma gets one when converted). */
    receivableAccountId: uuidSchema.optional(),
    issueDate: accountingDateSchema,
    /** Omit to use issueDate + the customer's payment terms (0 days if none). */
    dueDate: accountingDateSchema.optional(),
    /** Omit for the tenant's base currency -- the only currency invoices support in Phase 1. */
    currency: currencySchema.optional(),
    taxMode: z.enum(TAX_MODES).default("NONE"),
    reference: z.string().max(100).optional(),
    notes: z.string().max(2000).optional(),
    lines: invoiceLinesSchema,
  })
  .superRefine((body, ctx) => {
    checkInvoiceTax(body, ctx);
    if (body.dueDate !== undefined && body.dueDate < body.issueDate) {
      ctx.addIssue({ code: "custom", path: ["dueDate"], message: "dueDate can't be before issueDate" });
    }
  });

export type CreateInvoiceDto = z.infer<typeof createInvoiceSchema>;

/** PATCH /invoices/{id} -- drafts only. `lines`, when given, replaces every line. */
export const updateInvoiceSchema = z
  .object({
    customerId: uuidSchema.optional(),
    receivableAccountId: uuidSchema.optional(),
    issueDate: accountingDateSchema.optional(),
    /** null recomputes it from the customer's payment terms. */
    dueDate: accountingDateSchema.nullable().optional(),
    taxMode: z.enum(TAX_MODES).optional(),
    reference: z.string().max(100).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    lines: invoiceLinesSchema.optional(),
  })
  .refine(atLeastOneField, "Provide at least one field to update");

export type UpdateInvoiceDto = z.infer<typeof updateInvoiceSchema>;

/** POST /invoices/{id}/credit-notes -- a DRAFT credit note against an issued invoice. */
export const createCreditNoteSchema = z
  .object({
    clientUuid: uuidSchema,
    /** Omit for today (Africa/Nairobi). */
    issueDate: accountingDateSchema.optional(),
    /** Omit to use the invoice's own tax mode. */
    taxMode: z.enum(TAX_MODES).optional(),
    reference: z.string().max(100).optional(),
    /** Why the customer is being credited -- printed on the credit note. */
    notes: z.string().max(2000).optional(),
    lines: invoiceLinesSchema,
  })
  .superRefine(checkInvoiceTax);

export type CreateCreditNoteDto = z.infer<typeof createCreditNoteSchema>;

/** POST /invoices/{id}/issue */
export const issueInvoiceSchema = z.object({
  /** Issue even though it takes the customer past their credit limit.
   * Needs the invoices:override_credit_limit permission. */
  overrideCreditLimit: z.boolean().default(false),
});

/** POST /invoices/{id}/cancel */
export const cancelInvoiceSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

/** POST /invoices/{id}/payments -- a payment received outside M-Pesa STK push. */
export const recordInvoicePaymentSchema = z.object({
  clientUuid: uuidSchema,
  amountMinor: minorUnitsSchema.refine((n) => n > 0, "amountMinor must be greater than zero"),
  date: accountingDateSchema,
  /** The cash, bank or M-Pesa account the money went into. */
  receivedAccountId: uuidSchema,
  method: z.enum(INVOICE_PAYMENT_METHODS).default("CASH"),
  /** e.g. a cheque number or M-Pesa receipt code. */
  reference: z.string().max(100).optional(),
});

export type RecordInvoicePaymentDto = z.infer<typeof recordInvoicePaymentSchema>;

/** POST /invoices/{id}/convert -- pro-forma to a DRAFT invoice. */
export const convertProformaSchema = z.object({
  clientUuid: uuidSchema,
  /** Omit for today (Africa/Nairobi). */
  issueDate: accountingDateSchema.optional(),
  /** Omit for the pro-forma's own, else the business's RECEIVABLE account. */
  receivableAccountId: uuidSchema.optional(),
});

/** GET /invoices -- filters plus cursor pagination (Section 9.1). */
export const listInvoicesQuerySchema = paginationSchema.extend({
  status: z.enum(INVOICE_VIEW_STATUSES).optional(),
  kind: z.enum(SALES_KINDS).optional(),
  customer_id: uuidSchema.optional(),
  /** issue_date range, inclusive. */
  from: accountingDateSchema.optional(),
  to: accountingDateSchema.optional(),
});

export type ListInvoicesQueryDto = z.infer<typeof listInvoicesQuerySchema>;

// ---------------------------------------------------------------------
// Tenant -- the caller's own business
// ---------------------------------------------------------------------

/** PATCH /tenant. Omitted fields are unchanged; null clears. */
export const updateTenantSchema = z
  .object({
    /** The business's own tax PIN (e.g. KRA PIN), printed on its invoices. */
    taxIdentifier: taxIdentifierSchema.nullable().optional(),
    /** Manual journal approval (FR-JNL-01): null = off, 0 = every manual
     * journal, N = manual journals totalling N minor units or more. */
    manualJournalApprovalThresholdMinor: minorUnitsSchema.nullable().optional(),
  })
  .refine(atLeastOneField, "Provide at least one field to update");

export type UpdateTenantDto = z.infer<typeof updateTenantSchema>;

// ---------------------------------------------------------------------
// Aging -- FR-AR-04
// ---------------------------------------------------------------------

/** GET /receivables-aging */
export const agingQuerySchema = z.object({
  /** Age as at this date (default: today, Africa/Nairobi). */
  as_of: accountingDateSchema.optional(),
  /** Drill down: one customer's open invoices instead of the summary. */
  customer_id: uuidSchema.optional(),
});

export type AgingQueryDto = z.infer<typeof agingQuerySchema>;

// ---------------------------------------------------------------------
// Supplier bills -- FR-AP-02/03
// ---------------------------------------------------------------------

const billLineInputSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z
    .number()
    .positive()
    .max(99_999_999_999)
    .refine((q) => Math.abs(Math.round(q * 1000) - q * 1000) < 1e-6, "Quantity has at most three decimal places"),
  unitPriceMinor: minorUnitsSchema,
  /** The expense (or asset) account the purchase is for. */
  expenseAccountId: uuidSchema,
  /** Basis points: 1600 = 16% input VAT. */
  taxRateBps: z.number().int().min(0).max(10000).default(0),
  /** Input VAT account (VAT Recoverable). Omit for the business's VAT_INPUT account. */
  taxAccountId: uuidSchema.optional(),
});

const billLinesSchema = z.array(billLineInputSchema).min(1, "A bill needs at least one line").max(200);

function checkBillTax(
  body: { taxMode?: (typeof TAX_MODES)[number] | undefined; lines?: z.infer<typeof billLinesSchema> | undefined },
  ctx: z.RefinementCtx,
): void {
  body.lines?.forEach((line, i) => {
    if (body.taxMode === "NONE" && line.taxRateBps > 0) {
      ctx.addIssue({ code: "custom", path: ["lines", i, "taxRateBps"], message: "taxMode NONE allows no tax rate" });
    }
  });
}

/** POST /supplier-bills -- a DRAFT bill. */
export const createSupplierBillSchema = z
  .object({
    clientUuid: uuidSchema,
    branchId: uuidSchema.optional(),
    supplierId: uuidSchema,
    /** Accounts Payable. Omit for the business's PAYABLE account. */
    payableAccountId: uuidSchema.optional(),
    /** The date on the supplier's invoice. */
    billDate: accountingDateSchema,
    /** Omit to use billDate + the supplier's payment terms (0 days if none). */
    dueDate: accountingDateSchema.optional(),
    /** The supplier's own invoice number. Unique per supplier. */
    supplierReference: z.string().trim().min(1).max(100).optional(),
    currency: currencySchema.optional(),
    taxMode: z.enum(TAX_MODES).default("NONE"),
    reference: z.string().max(100).optional(),
    notes: z.string().max(2000).optional(),
    lines: billLinesSchema,
  })
  .superRefine((body, ctx) => {
    checkBillTax(body, ctx);
    if (body.dueDate !== undefined && body.dueDate < body.billDate) {
      ctx.addIssue({ code: "custom", path: ["dueDate"], message: "dueDate can't be before billDate" });
    }
  });

export type CreateSupplierBillDto = z.infer<typeof createSupplierBillSchema>;

/** PATCH /supplier-bills/{id} -- drafts only. `lines` replaces every line. */
export const updateSupplierBillSchema = z
  .object({
    supplierId: uuidSchema.optional(),
    payableAccountId: uuidSchema.optional(),
    billDate: accountingDateSchema.optional(),
    dueDate: accountingDateSchema.nullable().optional(),
    supplierReference: z.string().trim().min(1).max(100).nullable().optional(),
    taxMode: z.enum(TAX_MODES).optional(),
    reference: z.string().max(100).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    lines: billLinesSchema.optional(),
  })
  .refine(atLeastOneField, "Provide at least one field to update");

export type UpdateSupplierBillDto = z.infer<typeof updateSupplierBillSchema>;

/** POST /supplier-bills/{id}/debit-notes -- a DRAFT debit note against a posted bill. */
export const createDebitNoteSchema = z
  .object({
    clientUuid: uuidSchema,
    /** Omit for today (Africa/Nairobi). */
    noteDate: accountingDateSchema.optional(),
    taxMode: z.enum(TAX_MODES).optional(),
    reference: z.string().max(100).optional(),
    notes: z.string().max(2000).optional(),
    lines: billLinesSchema,
  })
  .superRefine(checkBillTax);

export type CreateDebitNoteDto = z.infer<typeof createDebitNoteSchema>;

/** POST /supplier-bills/{id}/payments -- money paid to the supplier. */
export const recordBillPaymentSchema = z.object({
  clientUuid: uuidSchema,
  amountMinor: minorUnitsSchema.refine((n) => n > 0, "amountMinor must be greater than zero"),
  date: accountingDateSchema,
  /** The cash, bank or M-Pesa account the money left. */
  paidFromAccountId: uuidSchema,
  method: z.enum(INVOICE_PAYMENT_METHODS).default("CASH"),
  reference: z.string().max(100).optional(),
});

export type RecordBillPaymentDto = z.infer<typeof recordBillPaymentSchema>;

/** GET /supplier-bills */
export const listSupplierBillsQuerySchema = paginationSchema.extend({
  status: z.enum(INVOICE_VIEW_STATUSES).optional(),
  kind: z.enum(BILL_KINDS).optional(),
  supplier_id: uuidSchema.optional(),
  /** bill_date range, inclusive. */
  from: accountingDateSchema.optional(),
  to: accountingDateSchema.optional(),
});

/** GET /payables-aging */
export const payablesAgingQuerySchema = z.object({
  as_of: accountingDateSchema.optional(),
  /** Drill down: one supplier's open bills. */
  supplier_id: uuidSchema.optional(),
});

// ---------------------------------------------------------------------
// Opening balances -- FR-ACC-04
// ---------------------------------------------------------------------

/**
 * PUT /opening-balances. Each line is one account's balance on `date`: a
 * debit for an asset or expense, a credit for a liability, equity or income.
 * Tag a receivable line with customerId (or a payable line with supplierId)
 * to give that customer or supplier their opening balance. The server
 * balances the journal against Opening Balance Equity.
 */
export const openingBalancesSchema = z.object({
  date: accountingDateSchema,
  lines: z.array(journalLineSchema).min(1, "Give at least one opening balance").max(500),
});

export type OpeningBalancesDto = z.infer<typeof openingBalancesSchema>;

// ---------------------------------------------------------------------
// Journal approval -- FR-JNL-01, FR-RBAC-03
// ---------------------------------------------------------------------

/** POST /journals/{id}/reject */
export const rejectJournalSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

/** GET /journals */
export const listJournalsQuerySchema = z.object({
  status: z.enum(["PENDING_APPROVAL", "POSTED", "REJECTED"]).optional(),
});
