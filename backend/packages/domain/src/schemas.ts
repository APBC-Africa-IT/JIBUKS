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

/** Shared shape of a customer/supplier -- a name list, deliberately separate
 * from createAccountSchema (no code, no type, no parent hierarchy). */
const partySchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().max(20).optional(),
  email: z.string().email().optional(),
  address: z.string().max(500).optional(),
  tags: z.array(z.string().max(50)).max(20).default([]),
});

export const createCustomerSchema = partySchema;
export const createSupplierSchema = partySchema;

export type CreateCustomerDto = z.infer<typeof createCustomerSchema>;
export type CreateSupplierDto = z.infer<typeof createSupplierSchema>;

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

export const createPeriodSchema = z.object({
  startDate: accountingDateSchema,
  endDate: accountingDateSchema,
});

export type CreatePeriodDto = z.infer<typeof createPeriodSchema>;

export const createUserSchema = z.object({
  externalIdpSubject: z.string().min(1).max(500),
  name: z.string().min(1).max(200),
  email: z.string().email().optional(),
  phone: z.string().max(20).optional(),
});

export type CreateUserDto = z.infer<typeof createUserSchema>;

export const createInviteSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200).optional(),
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