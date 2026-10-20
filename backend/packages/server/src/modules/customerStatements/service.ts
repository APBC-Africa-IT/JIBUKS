/**
 * Customer statements -- the Statements screen.
 *
 * Issuing a statement takes a snapshot of the customer's ledger for a
 * period (customerLedger) and of their aging at the statement date
 * (aging), numbers it ST-000001 and stores it, so the PDF always reprints
 * what the customer was given. Statements post nothing. The app shares
 * the PDF itself and then marks the statement sent; the server sends
 * nothing yet.
 */

import { ZodError } from "zod";
import { AGING_BUCKETS, DomainError, isUuid, type AgingBucket } from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import * as agingService from "../aging/service.js";
import * as customerLedger from "../customerLedger/service.js";
import type { CustomerTransaction } from "../customerLedger/service.js";
import * as customersService from "../customers/service.js";
import { todayInNairobi } from "../periods/service.js";
import * as tenantsService from "../tenants/service.js";
import { buildStatementPdfModel, renderStatementPdf } from "./pdf.js";
import * as repository from "./repository.js";
import type { StatementListRow } from "./repository.js";

export interface StatementView {
  readonly id: string;
  readonly number: string;
  readonly customer_id: string;
  readonly customer_name: string;
  readonly period_from: string;
  /** The statement date. */
  readonly period_to: string;
  /** Null means the business's base currency. */
  readonly currency: string | null;
  readonly opening_balance_minor: string;
  readonly total_debit_minor: string;
  readonly total_credit_minor: string;
  /** What the customer owed at period_to; negative = they are in credit. The list's amount. */
  readonly closing_balance_minor: string;
  /** Open invoices by age at period_to, plus what isn't invoiced; they add up to closing_balance_minor. */
  readonly aging: Readonly<Record<string, string>>;
  readonly message: string | null;
  readonly status: "SENT" | "NOT_SENT";
  readonly sent_at: string | null;
  readonly sent_by: string | null;
  readonly created_by: string;
  readonly created_at: string;
}

export interface StatementDetailView extends StatementView {
  readonly transactions: CustomerTransaction[];
}

function toView(row: StatementListRow): StatementView {
  return {
    id: row.id,
    number: row.number,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    period_from: row.period_from,
    period_to: row.period_to,
    currency: row.currency,
    opening_balance_minor: row.opening_balance_minor,
    total_debit_minor: row.total_debit_minor,
    total_credit_minor: row.total_credit_minor,
    closing_balance_minor: row.closing_balance_minor,
    aging: row.aging,
    message: row.message,
    status: row.sent_at ? "SENT" : "NOT_SENT",
    sent_at: row.sent_at,
    sent_by: row.sent_by,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

function toDetail(row: StatementListRow): StatementDetailView {
  return { ...toView(row), transactions: row.transactions as CustomerTransaction[] };
}

/** "2026-09-17" -> "2026-09-01". */
function firstOfMonth(date: string): string {
  return `${date.slice(0, 8)}01`;
}

/** Open invoice amounts by bucket at `asOf`, plus what isn't invoiced. Same field names as GET /receivables-aging. */
async function agingSnapshot(tenantId: string, customerId: string, asOf: string): Promise<Record<string, string>> {
  const detail = (await agingService.getCustomerAging(tenantId, customerId, asOf)) as {
    invoices: { bucket: AgingBucket; open_minor: string }[];
    not_invoiced_minor: string;
    balance_minor: string;
  };
  const buckets = Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as Record<AgingBucket, number>;
  for (const invoice of detail.invoices) {
    buckets[invoice.bucket] += Number(invoice.open_minor);
  }
  return {
    ...Object.fromEntries(AGING_BUCKETS.map((b) => [`${b.toLowerCase()}_minor`, String(buckets[b])])),
    not_invoiced_minor: detail.not_invoiced_minor,
    balance_minor: detail.balance_minor,
  };
}

export interface CreateStatementRequest {
  readonly tenantId: string;
  readonly clientUuid: string;
  readonly customerId: string;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly message?: string | undefined;
}

export async function createStatement(request: CreateStatementRequest, audit: AuditContext): Promise<StatementDetailView> {
  const to = request.to ?? todayInNairobi();
  const from = request.from ?? firstOfMonth(to);
  if (from > to) {
    throw new ZodError([{ code: "custom", path: ["from"], message: "from must be on or before to (to defaults to today)" }]);
  }
  const customer = await customersService.getCustomer(request.tenantId, request.customerId);
  const [ledger, aging] = await Promise.all([
    customerLedger.getCustomerTransactions({ tenantId: request.tenantId, customerId: customer.id, from, to }),
    agingSnapshot(request.tenantId, customer.id, to),
  ]);
  const row = await repository.insertStatement(
    {
      tenantId: request.tenantId,
      clientUuid: request.clientUuid,
      customerId: customer.id,
      periodFrom: from,
      periodTo: to,
      currency: ledger.currency,
      openingBalanceMinor: ledger.opening_balance_minor,
      totalDebitMinor: ledger.total_debit_minor,
      totalCreditMinor: ledger.total_credit_minor,
      closingBalanceMinor: ledger.closing_balance_minor,
      transactions: ledger.data,
      aging,
      message: request.message ?? null,
    },
    audit,
  );
  return toDetail(row);
}

export async function getStatement(tenantId: string, id: string): Promise<StatementDetailView> {
  const row = await repository.getStatement(tenantId, id);
  if (!row) {
    throw new DomainError("STATEMENT_NOT_FOUND", `Statement ${id} not found`);
  }
  return toDetail(row);
}

export interface ListStatementsRequest {
  readonly customerId?: string | undefined;
  readonly sent?: boolean | undefined;
  readonly q?: string | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface Page<T> {
  readonly data: T[];
  readonly next_cursor: string | null;
  readonly has_more: boolean;
}

function encodeCursor(row: { sort_key: string; id: string }): string {
  return Buffer.from(JSON.stringify({ t: row.sort_key, i: row.id })).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { t?: unknown; i?: unknown };
    if (typeof parsed.t === "string" && !Number.isNaN(Date.parse(parsed.t)) && isUuid(parsed.i)) {
      return { createdAt: parsed.t, id: parsed.i as string };
    }
  } catch {
    // fall through
  }
  throw new ZodError([{ code: "custom", path: ["cursor"], message: "Not a cursor returned by this endpoint" }]);
}

/** Newest first, without the transaction rows (GET /customer-statements/{id} has them). */
export async function listStatements(tenantId: string, request: ListStatementsRequest): Promise<Page<StatementView>> {
  const rows = await repository.listStatements(tenantId, {
    customerId: request.customerId,
    sent: request.sent,
    q: request.q,
    after: request.cursor !== undefined ? decodeCursor(request.cursor) : undefined,
    limit: request.limit,
  });
  const hasMore = rows.length > request.limit;
  const page = rows.slice(0, request.limit);
  return {
    data: page.map(toView),
    next_cursor: hasMore ? encodeCursor(page.at(-1)!) : null,
    has_more: hasMore,
  };
}

/** Records that the statement was shared. Marking one already sent changes nothing. */
export async function markSent(tenantId: string, id: string, audit: AuditContext): Promise<StatementDetailView> {
  const row = await repository.markSent(tenantId, id, audit);
  if (!row) {
    throw new DomainError("STATEMENT_NOT_FOUND", `Statement ${id} not found`);
  }
  return toDetail(row);
}

export async function getStatementPdf(tenantId: string, id: string): Promise<{ filename: string; pdf: Buffer }> {
  const statement = await getStatement(tenantId, id);
  const [tenant, customer] = await Promise.all([
    tenantsService.getTenant(tenantId),
    customersService.getCustomer(tenantId, statement.customer_id),
  ]);
  const model = buildStatementPdfModel({
    statement,
    currency: statement.currency ?? tenant.base_currency,
    business: { name: tenant.name, taxIdentifier: tenant.tax_identifier },
    customer: {
      name: customer.name,
      taxIdentifier: customer.tax_identifier,
      phone: customer.phone,
      email: customer.email,
      address: customer.address,
    },
  });
  return { filename: model.filename, pdf: await renderStatementPdf(model) };
}
