/**
 * Customer credit -- the Credit Note screen: what a customer has in credit,
 * using it on an invoice, and paying it back.
 *
 * Credit is held in two places: issued credit notes not yet fully used
 * (invoices module) and payments with money not applied to any invoice
 * (customerPayments). Both are already in the customer's balance -- the
 * credit was posted to receivables when the note was issued or the money
 * received -- so:
 *   - applying credit to an invoice posts NOTHING. It adds an allocation
 *     that points at the credit note or payment and shares its journal,
 *     and moves the amount from the credit to the invoice.
 *   - a refund posts Dr receivables (tagged with the customer) / Cr the
 *     money account, numbered RF-000001.
 * Without a choice of credit, the oldest is used first.
 */

import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { DomainError, isUuid, type CurrencyCode, type InvoicePaymentMethod } from "@jibuks/domain";
import { withTenant, type AuditContext } from "@jibuks/db";
import * as accountsService from "../accounts/service.js";
import * as customerPaymentsService from "../customerPayments/service.js";
import type { CustomerPaymentRow } from "../customerPayments/service.js";
import * as customersService from "../customers/service.js";
import * as invoicesService from "../invoices/service.js";
import type { InvoiceDetailView, InvoiceRow, TxClient } from "../invoices/service.js";
import * as journalsService from "../journals/service.js";
import { todayInNairobi } from "../periods/service.js";
import * as tenantsService from "../tenants/service.js";
import * as repository from "./repository.js";
import type { RefundListRow, RefundSourceRow } from "./repository.js";

// ---------------------------------------------------------------------
// Available credit
// ---------------------------------------------------------------------

export interface CreditSource {
  readonly type: "CREDIT_NOTE" | "PAYMENT";
  /** The credit note's id (an invoice id) or the customer payment's id. */
  readonly id: string;
  readonly number: string;
  readonly date: string;
  /** The credit note's total, or the payment's amount. */
  readonly amount_minor: string;
  /** What is left to apply or refund. */
  readonly remaining_minor: string;
  /** Credit notes: the invoice it was raised against (null for one against none). */
  readonly credited_invoice_id: string | null;
  /** Credit notes: the customer-facing note (e.g. "Returned goods"); payments: the reference. */
  readonly description: string | null;
  /** The receivable account the credit sits in. */
  readonly account_id: string;
}

export interface AvailableCredit {
  readonly customer_id: string;
  readonly customer_name: string;
  readonly currency: string;
  /** The Available Credit total. */
  readonly available_minor: string;
  /** Oldest first -- the order credit is used in when none is chosen. */
  readonly sources: CreditSource[];
}

function fromCreditNote(note: InvoiceRow): CreditSource {
  return {
    type: "CREDIT_NOTE",
    id: note.id,
    number: note.number!,
    date: note.issue_date,
    amount_minor: note.total_minor,
    remaining_minor: String(Number(note.total_minor) - Number(note.amount_paid_minor)),
    credited_invoice_id: note.credited_invoice_id,
    description: note.notes,
    account_id: note.receivable_account_id!,
  };
}

function fromPayment(payment: CustomerPaymentRow): CreditSource {
  return {
    type: "PAYMENT",
    id: payment.id,
    number: payment.number,
    date: payment.date,
    amount_minor: payment.amount_minor,
    remaining_minor: payment.unapplied_minor,
    credited_invoice_id: null,
    description: payment.reference,
    account_id: payment.credit_account_id!,
  };
}

async function listSources(tenantId: string, customerId: string): Promise<CreditSource[]> {
  const [notes, payments] = await Promise.all([
    invoicesService.listCreditNotesWithCredit(tenantId, customerId),
    customerPaymentsService.listWithCredit(tenantId, customerId),
  ]);
  return [...notes.map(fromCreditNote), ...payments.map(fromPayment)].sort(
    (a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number),
  );
}

export async function getAvailableCredit(tenantId: string, customerId: string): Promise<AvailableCredit> {
  const [customer, tenant] = await Promise.all([
    customersService.getCustomer(tenantId, customerId),
    tenantsService.getTenant(tenantId),
  ]);
  const sources = await listSources(tenantId, customer.id);
  return {
    customer_id: customer.id,
    customer_name: customer.name,
    currency: customer.currency ?? tenant.base_currency,
    available_minor: String(sources.reduce((sum, s) => sum + Number(s.remaining_minor), 0)),
    sources,
  };
}

// ---------------------------------------------------------------------
// Choosing and using credit
// ---------------------------------------------------------------------

export interface RequestedSource {
  readonly creditNoteId?: string | undefined;
  readonly customerPaymentId?: string | undefined;
  readonly amountMinor: number;
}

interface PlannedUse {
  readonly source: CreditSource;
  readonly amountMinor: number;
}

/** The chosen credit, checked against what is left; or, with none chosen, the oldest first up to `amountMinor`. */
function planUse(available: readonly CreditSource[], amountMinor: number, requested?: readonly RequestedSource[]): PlannedUse[] {
  if (!requested) {
    const plan: PlannedUse[] = [];
    let remaining = amountMinor;
    for (const source of available) {
      if (remaining === 0) break;
      const take = Math.min(remaining, Number(source.remaining_minor));
      plan.push({ source, amountMinor: take });
      remaining -= take;
    }
    if (remaining > 0) {
      throw new DomainError("CREDIT_NOT_AVAILABLE", `Only ${amountMinor - remaining} of ${amountMinor} is available in credit (minor units)`);
    }
    return plan;
  }
  return requested.map((r) => {
    const id = (r.creditNoteId ?? r.customerPaymentId)!;
    const type = r.creditNoteId ? "CREDIT_NOTE" : "PAYMENT";
    const source = available.find((s) => s.id === id && s.type === type);
    if (!source) {
      throw new DomainError("CREDIT_NOT_AVAILABLE", `${type === "CREDIT_NOTE" ? "Credit note" : "Payment"} ${id} has no credit left for this customer`);
    }
    if (r.amountMinor > Number(source.remaining_minor)) {
      throw new DomainError(
        "CREDIT_NOT_AVAILABLE",
        `${source.number} has ${source.remaining_minor} left, less than the ${r.amountMinor} asked for (minor units)`,
      );
    }
    return { source, amountMinor: r.amountMinor };
  });
}

interface LockedSources {
  readonly notes: Map<string, InvoiceRow>;
  readonly payments: Map<string, CustomerPaymentRow>;
}

/** Locks every source in id order, then re-checks each still has what the plan takes. */
async function lockSources(client: TxClient, plan: readonly PlannedUse[]): Promise<LockedSources> {
  const notes = new Map<string, InvoiceRow>();
  const payments = new Map<string, CustomerPaymentRow>();
  for (const { source } of [...plan].sort((a, b) => a.source.id.localeCompare(b.source.id))) {
    if (source.type === "CREDIT_NOTE") {
      notes.set(source.id, (await invoicesService.lockInvoice(client, source.id))!);
    } else {
      payments.set(source.id, (await customerPaymentsService.lockPayment(client, source.id))!);
    }
  }
  for (const { source, amountMinor } of plan) {
    const left =
      source.type === "CREDIT_NOTE"
        ? Number(notes.get(source.id)!.total_minor) - Number(notes.get(source.id)!.amount_paid_minor)
        : Number(payments.get(source.id)!.unapplied_minor);
    if (amountMinor > left) {
      throw new DomainError("CREDIT_NOT_AVAILABLE", `${source.number} was used meanwhile; try again`);
    }
  }
  return { notes, payments };
}

async function useSource(
  client: TxClient,
  locked: LockedSources,
  use: PlannedUse,
  as: "APPLIED" | "REFUNDED",
  audit: AuditContext,
): Promise<void> {
  if (use.source.type === "CREDIT_NOTE") {
    locked.notes.set(use.source.id, await invoicesService.useCredit(client, locked.notes.get(use.source.id)!, use.amountMinor, audit));
  } else {
    locked.payments.set(
      use.source.id,
      await customerPaymentsService.useCredit(client, locked.payments.get(use.source.id)!, use.amountMinor, as, audit),
    );
  }
}

// ---------------------------------------------------------------------
// Apply credit to an invoice
// ---------------------------------------------------------------------

export interface ApplyCreditRequest {
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly clientUuid: string;
  readonly amountMinor?: number | undefined;
  readonly date?: string | undefined;
  readonly sources?: readonly RequestedSource[] | undefined;
}

export async function applyCredit(request: ApplyCreditRequest, audit: AuditContext): Promise<InvoiceDetailView> {
  const invoice = await invoicesService.getInvoiceRow(request.tenantId, request.invoiceId);
  if (invoice.kind !== "INVOICE" || (invoice.status !== "ISSUED" && invoice.status !== "PART_PAID")) {
    throw new DomainError("INVOICE_INVALID_STATE", `Credit is applied to issued, unpaid or part-paid invoices; ${invoice.number ?? "this draft"} isn't one`);
  }
  const due = invoicesService.balanceDue(invoice);
  const date = request.date ?? todayInNairobi();
  if (date < invoice.issue_date) {
    throw new ZodError([{ code: "custom", path: ["date"], message: `Credit can't be applied before the invoice's date (${invoice.issue_date})` }]);
  }
  const available = await listSources(request.tenantId, invoice.customer_id!);
  const totalAvailable = available.reduce((sum, s) => sum + Number(s.remaining_minor), 0);
  const requestedTotal = request.sources?.reduce((sum, s) => sum + s.amountMinor, 0);
  const amountMinor = request.amountMinor ?? requestedTotal ?? Math.min(due, totalAvailable);
  if (amountMinor === 0) {
    throw new DomainError("CREDIT_NOT_AVAILABLE", "The customer has no credit to apply");
  }
  if (amountMinor > due) {
    throw new DomainError("INVOICE_OVERPAYMENT", `${amountMinor} is more than the ${due} still owed on ${invoice.number} (minor units)`);
  }
  const plan = planUse(available, amountMinor, request.sources);
  for (const { source } of plan) {
    if (source.account_id !== invoice.receivable_account_id) {
      throw new DomainError(
        "PAYMENT_ALLOCATION_INVALID",
        `${source.number}'s credit is in a different receivable account from ${invoice.number}; move it with a journal first`,
      );
    }
    if (source.date > date) {
      throw new ZodError([{ code: "custom", path: ["date"], message: `${source.number} is dated ${source.date}, after ${date}` }]);
    }
  }

  await withTenant(request.tenantId, async (client) => {
    let current = (await invoicesService.lockInvoice(client, invoice.id))!;
    if (current.status !== "ISSUED" && current.status !== "PART_PAID") {
      throw new DomainError("INVOICE_INVALID_STATE", `${invoice.number} changed meanwhile; try again`);
    }
    if (amountMinor > invoicesService.balanceDue(current)) {
      throw new DomainError("INVOICE_OVERPAYMENT", `${invoice.number} changed meanwhile and now owes less; try again`);
    }
    const locked = await lockSources(client, plan);
    for (const [i, use] of plan.entries()) {
      const fromNote = use.source.type === "CREDIT_NOTE";
      const payment = fromNote ? null : locked.payments.get(use.source.id)!;
      const note = fromNote ? locked.notes.get(use.source.id)! : null;
      ({ invoice: current } = await invoicesService.applyAllocation(
        client,
        current,
        {
          // The request's clientUuid identifies the first allocation: a retry hits 409.
          clientUuid: i === 0 ? request.clientUuid : randomUUID(),
          method: fromNote ? "CREDIT_NOTE" : payment!.method,
          amountMinor: use.amountMinor,
          unappliedMinor: 0,
          date,
          reference: use.source.number,
          journalId: fromNote ? note!.journal_id! : payment!.journal_id,
          ...(fromNote ? { creditNoteId: note!.id } : { customerPaymentId: payment!.id }),
        },
        audit,
      ));
      await useSource(client, locked, use, "APPLIED", audit);
    }
  });
  return invoicesService.getInvoice(request.tenantId, invoice.id);
}

// ---------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------

export interface RefundSourceView {
  readonly type: "CREDIT_NOTE" | "PAYMENT";
  readonly id: string;
  readonly number: string;
  readonly amount_minor: string;
}

export type RefundView = RefundListRow;

export interface RefundDetailView extends RefundView {
  /** The credit it paid back. */
  readonly sources: RefundSourceView[];
}

function toSourceView(row: RefundSourceRow): RefundSourceView {
  return row.credit_note_id
    ? { type: "CREDIT_NOTE", id: row.credit_note_id, number: row.number, amount_minor: row.amount_minor }
    : { type: "PAYMENT", id: row.customer_payment_id!, number: row.number, amount_minor: row.amount_minor };
}

export interface CreateRefundRequest {
  readonly tenantId: string;
  readonly clientUuid: string;
  readonly customerId: string;
  readonly amountMinor: number;
  readonly date: string;
  readonly method: InvoicePaymentMethod;
  readonly paidFromAccountId?: string | undefined;
  readonly reference?: string | undefined;
  readonly memo?: string | undefined;
  readonly sources?: readonly RequestedSource[] | undefined;
}

export async function createRefund(request: CreateRefundRequest, audit: AuditContext): Promise<RefundDetailView> {
  const [customer, tenant] = await Promise.all([
    customersService.getCustomer(request.tenantId, request.customerId),
    tenantsService.getTenant(request.tenantId),
  ]);
  const currency = customer.currency ?? tenant.base_currency;
  const plan = planUse(await listSources(request.tenantId, customer.id), request.amountMinor, request.sources);
  for (const { source } of plan) {
    if (source.date > request.date) {
      throw new ZodError([{ code: "custom", path: ["date"], message: `${source.number} is dated ${source.date}, after ${request.date}` }]);
    }
  }
  const paidFromAccountId =
    request.paidFromAccountId ??
    (await accountsService.defaultMoneyAccountId(request.tenantId, request.method, "paidFromAccountId", audit));

  const narrative = `Refund to ${customer.name}`;
  const byAccount = new Map<string, number>();
  for (const { source, amountMinor } of plan) {
    byAccount.set(source.account_id, (byAccount.get(source.account_id) ?? 0) + amountMinor);
  }
  const prepared = await journalsService.prepareJournal(
    {
      tenantId: request.tenantId,
      clientUuid: request.clientUuid,
      date: request.date,
      currency: currency as CurrencyCode,
      description: narrative, // numbered inside the transaction
      source: "PAYMENT",
      lines: [
        ...Array.from(byAccount, ([accountId, debitMinor]) => ({
          accountId,
          debitMinor,
          creditMinor: 0,
          narrative,
          customerId: customer.id,
        })),
        { accountId: paidFromAccountId, debitMinor: 0, creditMinor: request.amountMinor, narrative },
      ],
    },
    audit,
  );

  const refundId = await withTenant(request.tenantId, async (client) => {
    const locked = await lockSources(client, plan);
    const number = await repository.nextNumber(client, request.tenantId);
    const journal = await journalsService.postPreparedJournal(
      client,
      { ...prepared, description: `Refund ${number} to ${customer.name}`, reference: request.reference ?? number },
      audit,
    );
    const refund = await repository.insertRefund(
      client,
      {
        tenantId: request.tenantId,
        clientUuid: request.clientUuid,
        number,
        customerId: customer.id,
        date: request.date,
        currency,
        amountMinor: request.amountMinor,
        method: request.method,
        paidFromAccountId,
        reference: request.reference ?? null,
        memo: request.memo ?? null,
        journalId: journal.id,
        sources: plan.map(({ source, amountMinor }) => ({
          creditNoteId: source.type === "CREDIT_NOTE" ? source.id : null,
          customerPaymentId: source.type === "PAYMENT" ? source.id : null,
          amountMinor,
        })),
      },
      audit,
    );
    for (const use of plan) {
      await useSource(client, locked, use, "REFUNDED", audit);
    }
    return refund.id;
  });
  return getRefund(request.tenantId, refundId);
}

export async function getRefund(tenantId: string, id: string): Promise<RefundDetailView> {
  const row = isUuid(id) ? await repository.getRefund(tenantId, id) : null;
  if (!row) {
    throw new DomainError("CUSTOMER_REFUND_NOT_FOUND", `Refund ${id} not found`);
  }
  const sources = await repository.listSources(tenantId, [row.id]);
  return { ...row, sources: sources.map(toSourceView) };
}

export interface ListRefundsRequest {
  readonly customerId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
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

/** Newest first, without sources (GET /customer-refunds/{id} has them). */
export async function listRefunds(tenantId: string, request: ListRefundsRequest): Promise<Page<RefundView>> {
  const rows = await repository.listRefunds(tenantId, {
    customerId: request.customerId,
    from: request.from,
    to: request.to,
    after: request.cursor !== undefined ? decodeCursor(request.cursor) : undefined,
    limit: request.limit,
  });
  const hasMore = rows.length > request.limit;
  const page = rows.slice(0, request.limit).map(({ sort_key: _sortKey, ...row }) => row);
  return { data: page, next_cursor: hasMore ? encodeCursor(rows[request.limit - 1]!) : null, has_more: hasMore };
}

/** The refunds posted by these journals, by journal id (customerLedger names rows with these). */
export async function listJournalRefunds(tenantId: string, journalIds: readonly string[]): Promise<Map<string, RefundView>> {
  const refunds = await repository.listByJournalIds(tenantId, journalIds);
  return new Map(refunds.map((r) => [r.journal_id, r]));
}
