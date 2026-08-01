/**
 * Zod validation schemas shared by mobile, web and server.
 *
 * SRS C-01: "request and response validation schemas" MUST be shared and
 * MUST NOT be reimplemented per surface. R-07 tracks divergence risk.
 * Section 5.2: "request validation with Zod shared with the clients".
 */

import { z } from "zod";
import { CURRENCY_CODES } from "./currency.js";
import { ACCOUNT_TYPES } from "./accounts.js";
import { JOURNAL_SOURCES } from "./journal.js";

export const uuidSchema = z.string().uuid();

export const currencySchema = z.enum(CURRENCY_CODES as [string, ...string[]]);

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

export const journalLineSchema = z
  .object({
    accountId: uuidSchema,
    debitMinor: minorUnitsSchema.default(0),
    creditMinor: minorUnitsSchema.default(0),
    narrative: z.string().max(500).optional(),
    projectId: uuidSchema.optional(),
    department: z.string().max(100).optional(),
  })
  .refine((l) => !(l.debitMinor > 0 && l.creditMinor > 0), {
    message: "A line carries either a debit or a credit, never both",
    path: ["debitMinor"],
  })
  .refine((l) => l.debitMinor > 0 || l.creditMinor > 0, {
    message: "A line must carry a non-zero debit or credit",
    path: ["debitMinor"],
  });

export const journalInputSchema = z.object({
  clientUuid: uuidSchema,
  branchId: uuidSchema.optional(),
  date: accountingDateSchema,
  currency: currencySchema,
  description: z.string().min(1).max(500),
  reference: z.string().max(100).optional(),
  source: z.enum(JOURNAL_SOURCES as unknown as [string, ...string[]]).default("MANUAL"),
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
  source: z.enum(JOURNAL_SOURCES as unknown as [string, ...string[]]).default("MANUAL"),
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

export const createPeriodSchema = z.object({
  startDate: accountingDateSchema,
  endDate: accountingDateSchema,
});

export type CreatePeriodDto = z.infer<typeof createPeriodSchema>;

/** Cursor pagination (Section 9.1). Offset pagination is not used. */
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(500).optional(),
});

export type JournalInputDto = z.infer<typeof journalInputSchema>;
export type CreateAccountDto = z.infer<typeof createAccountSchema>;
export type PaginationDto = z.infer<typeof paginationSchema>;