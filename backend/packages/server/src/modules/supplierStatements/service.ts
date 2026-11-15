/**
 * Supplier statements -- the Reports tab's Supplier Statement: a supplier's
 * transactions for a period with a running balance, what the business owes
 * them by age at the end of it, and a PDF.
 *
 * Unlike customer statements nothing is stored or numbered (user decision
 * 2026-11-12): it is the supplier ledger (supplierLedger) and payables aging
 * (aging) read for the period on every request, so it always matches
 * GET /suppliers/{id}/transactions and GET /payables-aging.
 *
 * The balance is what the business owes the supplier: credit_minor (bills,
 * opening balances, refunds received) adds to it, debit_minor (payments,
 * debit notes, cancellations) takes off it.
 */

import { ZodError } from "zod";
import { AGING_BUCKETS, type AgingBucket } from "@jibuks/domain";
import * as agingService from "../aging/service.js";
import { renderStatementPdf } from "../customerStatements/pdf.js";
import * as supplierLedger from "../supplierLedger/service.js";
import type { SupplierTransaction } from "../supplierLedger/service.js";
import { todayInNairobi } from "../periods/service.js";
import * as suppliersService from "../suppliers/service.js";
import * as tenantsService from "../tenants/service.js";
import { buildSupplierStatementPdfModel } from "./pdf.js";

export interface SupplierStatement {
  readonly supplier_id: string;
  readonly supplier_code: string;
  readonly supplier_name: string;
  /** The supplier's currency, the base currency filled in. */
  readonly currency: string;
  readonly period_from: string;
  readonly period_to: string;
  /** Owed to the supplier before period_from. */
  readonly opening_balance_minor: string;
  /** Bills, opening balances and refunds received in the period. */
  readonly total_credit_minor: string;
  /** Payments, debit notes and cancellations in the period. */
  readonly total_debit_minor: string;
  /** Owed at the end of period_to; negative = supplier credit. */
  readonly closing_balance_minor: string;
  readonly transactions: SupplierTransaction[];
  /** Open bill amounts by age at period_to, plus not_billed_minor and balance_minor. Same field names as GET /payables-aging. */
  readonly aging: Readonly<Record<string, string>>;
}

/** "2026-09-17" -> "2026-09-01". */
function firstOfMonth(date: string): string {
  return `${date.slice(0, 8)}01`;
}

async function agingAt(tenantId: string, supplierId: string, asOf: string): Promise<Record<string, string>> {
  const detail = (await agingService.getSupplierAging(tenantId, supplierId, asOf)) as {
    bills: { bucket: AgingBucket; open_minor: string }[];
    not_billed_minor: string;
    balance_minor: string;
  };
  const buckets = Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as Record<AgingBucket, number>;
  for (const bill of detail.bills) {
    buckets[bill.bucket] += Number(bill.open_minor);
  }
  return {
    ...Object.fromEntries(AGING_BUCKETS.map((b) => [`${b.toLowerCase()}_minor`, String(buckets[b])])),
    not_billed_minor: detail.not_billed_minor,
    balance_minor: detail.balance_minor,
  };
}

export interface StatementRequest {
  readonly tenantId: string;
  readonly supplierId: string;
  /** Default today (Africa/Nairobi). */
  readonly to?: string | undefined;
  /** Default the 1st of to's month. */
  readonly from?: string | undefined;
}

export async function getStatement(request: StatementRequest): Promise<SupplierStatement> {
  const to = request.to ?? todayInNairobi();
  const from = request.from ?? firstOfMonth(to);
  if (from > to) {
    throw new ZodError([{ code: "custom", path: ["from"], message: "from must be on or before to (to defaults to today)" }]);
  }
  const [supplier, tenant] = await Promise.all([
    suppliersService.getSupplier(request.tenantId, request.supplierId),
    tenantsService.getTenant(request.tenantId),
  ]);
  const [ledger, aging] = await Promise.all([
    supplierLedger.getSupplierTransactions({ tenantId: request.tenantId, supplierId: supplier.id, from, to }),
    agingAt(request.tenantId, supplier.id, to),
  ]);
  return {
    supplier_id: supplier.id,
    supplier_code: supplier.code,
    supplier_name: supplier.name,
    currency: supplier.currency ?? tenant.base_currency,
    period_from: from,
    period_to: to,
    opening_balance_minor: ledger.opening_balance_minor,
    total_credit_minor: ledger.total_credit_minor,
    total_debit_minor: ledger.total_debit_minor,
    closing_balance_minor: ledger.closing_balance_minor,
    transactions: ledger.data,
    aging,
  };
}

/** The statement as a PDF, built on request (nothing is stored). */
export async function getStatementPdf(request: StatementRequest): Promise<{ filename: string; pdf: Buffer }> {
  const statement = await getStatement(request);
  const [tenant, supplier] = await Promise.all([
    tenantsService.getTenant(request.tenantId),
    suppliersService.getSupplier(request.tenantId, request.supplierId),
  ]);
  const model = buildSupplierStatementPdfModel({
    statement,
    business: { name: tenant.name, taxIdentifier: tenant.tax_identifier },
    supplier: {
      name: supplier.name,
      taxIdentifier: supplier.tax_identifier,
      phone: supplier.phone,
      email: supplier.email,
      address: [supplier.address, supplier.city].filter(Boolean).join(", ") || null,
    },
  });
  return { filename: model.filename, pdf: await renderStatementPdf(model) };
}
