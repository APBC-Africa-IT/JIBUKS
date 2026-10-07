/**
 * Invoice model and arithmetic (FR-AR-02/05, FR-TAX-01).
 *
 * Shared with the clients (C-01) so the app can preview exactly the totals
 * the server will store and post. All money is integer minor units; the
 * only rounding is half-up, once per line, in computeInvoiceLine.
 */

import { DomainError } from "./errors.js";

/** Sales side (AR): INVOICE, CREDIT_NOTE, PROFORMA. Supplier side (AP): BILL, DEBIT_NOTE. */
export const INVOICE_KINDS = ["INVOICE", "CREDIT_NOTE", "PROFORMA", "BILL", "DEBIT_NOTE"] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

export const SALES_KINDS = ["INVOICE", "CREDIT_NOTE", "PROFORMA"] as const;
export const BILL_KINDS = ["BILL", "DEBIT_NOTE"] as const;

/** What is stored. OVERDUE is derived on read -- see INVOICE_VIEW_STATUSES. */
export const INVOICE_STATUSES = ["DRAFT", "ISSUED", "PART_PAID", "PAID", "CANCELLED"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** What API clients see: the SRS's six statuses (FR-AR-05). */
export const INVOICE_VIEW_STATUSES = [...INVOICE_STATUSES, "OVERDUE"] as const;
export type InvoiceViewStatus = (typeof INVOICE_VIEW_STATUSES)[number];

/**
 * EXCLUSIVE: unit prices are before tax; tax is added on top.
 * INCLUSIVE: unit prices already include tax; tax is extracted from them.
 * NONE: no tax on any line.
 */
export const TAX_MODES = ["EXCLUSIVE", "INCLUSIVE", "NONE"] as const;
export type TaxMode = (typeof TAX_MODES)[number];

export const INVOICE_PAYMENT_METHODS = ["CASH", "BANK", "MPESA", "OTHER"] as const;
export type InvoicePaymentMethod = (typeof INVOICE_PAYMENT_METHODS)[number];

export const INVOICE_NUMBER_PREFIXES: Readonly<Record<InvoiceKind, string>> = {
  INVOICE: "INV",
  CREDIT_NOTE: "CN",
  PROFORMA: "PF",
  BILL: "BILL",
  DEBIT_NOTE: "DN",
};

/** INV-000042 -- zero-padded to six digits, growing past that if needed. */
export function formatInvoiceNumber(kind: InvoiceKind, sequence: number): string {
  return `${INVOICE_NUMBER_PREFIXES[kind]}-${String(sequence).padStart(6, "0")}`;
}

/** Quantities carry at most three decimal places (numeric(14,3) in the database). */
export const QUANTITY_SCALE = 1000;

export interface InvoiceLineAmountsInput {
  /** e.g. 2.5 -- at most three decimal places. */
  readonly quantity: number;
  readonly unitPriceMinor: number;
  /** Basis points: 1600 = 16%. */
  readonly taxRateBps: number;
}

export interface InvoiceLineAmounts {
  readonly netMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
}

export interface InvoiceTotals {
  readonly lines: readonly InvoiceLineAmounts[];
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
}

/** round(numerator / denominator), halves away from zero, for non-negative inputs. */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

function toSafe(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new DomainError("MONEY_OUT_OF_RANGE", `Invoice amount ${value} is too large`);
  }
  return n;
}

/** The quantity in thousandths, rejecting more than three decimal places. */
export function quantityInThousandths(quantity: number): number {
  const scaled = Math.round(quantity * QUANTITY_SCALE);
  if (Math.abs(scaled - quantity * QUANTITY_SCALE) > 1e-6) {
    throw new DomainError("MONEY_TOO_PRECISE", `Quantity ${quantity} has more than three decimal places`);
  }
  return scaled;
}

export function computeInvoiceLine(line: InvoiceLineAmountsInput, taxMode: TaxMode): InvoiceLineAmounts {
  const rate = BigInt(taxMode === "NONE" ? 0 : line.taxRateBps);
  // quantity x unit price, rounded once to whole minor units.
  const amount = divideHalfUp(BigInt(quantityInThousandths(line.quantity)) * BigInt(line.unitPriceMinor), 1000n);

  let net: bigint;
  let tax: bigint;
  if (taxMode === "INCLUSIVE") {
    tax = divideHalfUp(amount * rate, 10000n + rate);
    net = amount - tax;
  } else {
    net = amount;
    tax = divideHalfUp(amount * rate, 10000n);
  }
  return { netMinor: toSafe(net), taxMinor: toSafe(tax), totalMinor: toSafe(net + tax) };
}

export function computeInvoiceTotals(lines: readonly InvoiceLineAmountsInput[], taxMode: TaxMode): InvoiceTotals {
  const computed = lines.map((line) => computeInvoiceLine(line, taxMode));
  const sum = (pick: (l: InvoiceLineAmounts) => number) => computed.reduce((acc, l) => acc + pick(l), 0);
  const subtotalMinor = sum((l) => l.netMinor);
  const taxMinor = sum((l) => l.taxMinor);
  const totalMinor = subtotalMinor + taxMinor;
  if (!Number.isSafeInteger(totalMinor)) {
    throw new DomainError("MONEY_OUT_OF_RANGE", "Invoice total is too large");
  }
  return { lines: computed, subtotalMinor, taxMinor, totalMinor };
}

/** The SRS status a client sees: an invoice or bill issued or part-paid past its due date is OVERDUE. */
export function invoiceViewStatus(
  kind: InvoiceKind,
  status: InvoiceStatus,
  dueDate: string | null,
  today: string,
): InvoiceViewStatus {
  if ((kind === "INVOICE" || kind === "BILL") && (status === "ISSUED" || status === "PART_PAID") && dueDate !== null && dueDate < today) {
    return "OVERDUE";
  }
  return status;
}

/**
 * Aging buckets (FR-AR-04, FR-AP-03): current, then 30-day bands past the
 * due date, then over 90.
 */
export const AGING_BUCKETS = ["CURRENT", "DAYS_1_30", "DAYS_31_60", "DAYS_61_90", "DAYS_OVER_90"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/** Whole days from dueDate to asOf; zero or less means not yet overdue. */
export function daysPastDue(dueDate: string, asOf: string): number {
  return Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000);
}

export function agingBucket(daysPastDueValue: number): AgingBucket {
  if (daysPastDueValue <= 0) return "CURRENT";
  if (daysPastDueValue <= 30) return "DAYS_1_30";
  if (daysPastDueValue <= 60) return "DAYS_31_60";
  if (daysPastDueValue <= 90) return "DAYS_61_90";
  return "DAYS_OVER_90";
}
