/**
 * Supplier credit -- what a supplier owes back to the business, using it on
 * a bill, and the supplier paying it back. The supplier side of
 * customerCredits.
 *
 * Credit is held in two places: posted debit notes not yet fully used
 * (supplierBills) and supplier payments with money not applied to any bill
 * -- advances (supplierPayments). Both are already in the supplier's
 * balance -- the debit to payables was posted when the note was posted or
 * the money paid -- so:
 *   - applying credit to a bill posts NOTHING. It adds an allocation that
 *     points at the debit note or payment and shares its journal, and moves
 *     the amount from the credit to the bill.
 *   - a refund received posts Dr the money account / Cr payables (tagged
 *     with the supplier), numbered SRF-000001.
 * Without a choice of credit, the oldest is used first.
 */

import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { DomainError, isUuid, type CurrencyCode, type SupplierPaymentMethod } from "@jibuks/domain";
import { withTenant, type AuditContext } from "@jibuks/db";
import * as accountsService from "../accounts/service.js";
import type { TxClient } from "../invoices/service.js";
import * as journalsService from "../journals/service.js";
import { todayInNairobi } from "../periods/service.js";
import * as supplierBillsService from "../supplierBills/service.js";
import type { BillDetailView, BillRow } from "../supplierBills/service.js";
import * as supplierPaymentsService from "../supplierPayments/service.js";
import type { SupplierPaymentRow, SupplierPaymentView } from "../supplierPayments/service.js";
import * as suppliersService from "../suppliers/service.js";
import * as tenantsService from "../tenants/service.js";
import * as repository from "./repository.js";
import type { SupplierRefundListRow, SupplierRefundSourceRow } from "./repository.js";

// ---------------------------------------------------------------------
// Available credit
// ---------------------------------------------------------------------

export interface SupplierCreditSource {
  readonly type: "DEBIT_NOTE" | "PAYMENT";
  /** The debit note's id (a bill id) or the supplier payment's id. */
  readonly id: string;
  readonly number: string;
  readonly date: string;
  /** The debit note's total, or the payment's amount. */
  readonly amount_minor: string;
  /** What is left to apply or have refunded. */
  readonly remaining_minor: string;
  /** Debit notes: the bill it was raised against (null for one against none). */
  readonly debited_bill_id: string | null;
  /** Debit notes: the supplier's own credit note number; payments: null. */
  readonly supplier_reference: string | null;
  /** Debit notes: the note's message (e.g. "Returned goods"); payments: the reference. */
  readonly description: string | null;
  /** The payable account the credit sits in. */
  readonly account_id: string;
}

export interface AvailableSupplierCredit {
  readonly supplier_id: string;
  readonly supplier_name: string;
  readonly currency: string;
  /** The Available Credit total. */
  readonly available_minor: string;
  /** Oldest first -- the order credit is used in when none is chosen. */
  readonly sources: SupplierCreditSource[];
}

function fromDebitNote(note: BillRow): SupplierCreditSource {
  return {
    type: "DEBIT_NOTE",
    id: note.id,
    number: note.number!,
    date: note.issue_date,
    amount_minor: note.total_minor,
    remaining_minor: String(Number(note.total_minor) - Number(note.amount_paid_minor)),
    debited_bill_id: note.credited_invoice_id,
    supplier_reference: note.supplier_reference,
    description: note.notes,
    account_id: note.receivable_account_id!,
  };
}

function fromPayment(payment: SupplierPaymentView): SupplierCreditSource {
  return {
    type: "PAYMENT",
    id: payment.id,
    number: payment.number,
    date: payment.date,
    amount_minor: payment.amount_minor,
    remaining_minor: payment.unapplied_minor,
    debited_bill_id: null,
    supplier_reference: null,
    description: payment.reference,
    account_id: payment.credit_account_id!,
  };
}

async function listSources(tenantId: string, supplierId: string): Promise<SupplierCreditSource[]> {
  const [notes, payments] = await Promise.all([
    supplierBillsService.listDebitNotesWithCredit(tenantId, supplierId),
    supplierPaymentsService.listWithCredit(tenantId, supplierId),
  ]);
  return [...notes.map(fromDebitNote), ...payments.map(fromPayment)].sort(
    (a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number),
  );
}

export async function getAvailableCredit(tenantId: string, supplierId: string): Promise<AvailableSupplierCredit> {
  const [supplier, tenant] = await Promise.all([
    suppliersService.getSupplier(tenantId, supplierId),
    tenantsService.getTenant(tenantId),
  ]);
  const sources = await listSources(tenantId, supplier.id);
  return {
    supplier_id: supplier.id,
    supplier_name: supplier.name,
    currency: supplier.currency ?? tenant.base_currency,
    available_minor: String(sources.reduce((sum, s) => sum + Number(s.remaining_minor), 0)),
    sources,
  };
}

// ---------------------------------------------------------------------
// Choosing and using credit
// ---------------------------------------------------------------------

export interface RequestedSource {
  readonly debitNoteId?: string | undefined;
  readonly supplierPaymentId?: string | undefined;
  readonly amountMinor: number;
}

interface PlannedUse {
  readonly source: SupplierCreditSource;
  readonly amountMinor: number;
}

/** The chosen credit, checked against what is left; or, with none chosen, the oldest first up to `amountMinor`. */
function planUse(available: readonly SupplierCreditSource[], amountMinor: number, requested?: readonly RequestedSource[]): PlannedUse[] {
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
    const id = (r.debitNoteId ?? r.supplierPaymentId)!;
    const type = r.debitNoteId ? "DEBIT_NOTE" : "PAYMENT";
    const source = available.find((s) => s.id === id && s.type === type);
    if (!source) {
      throw new DomainError("CREDIT_NOT_AVAILABLE", `${type === "DEBIT_NOTE" ? "Debit note" : "Payment"} ${id} has no credit left for this supplier`);
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
  readonly notes: Map<string, BillRow>;
  readonly payments: Map<string, SupplierPaymentRow>;
}

/** Locks every source in id order, then re-checks each still has what the plan takes. */
async function lockSources(client: TxClient, plan: readonly PlannedUse[]): Promise<LockedSources> {
  const notes = new Map<string, BillRow>();
  const payments = new Map<string, SupplierPaymentRow>();
  for (const { source } of [...plan].sort((a, b) => a.source.id.localeCompare(b.source.id))) {
    if (source.type === "DEBIT_NOTE") {
      notes.set(source.id, (await supplierBillsService.lockBill(client, source.id))!);
    } else {
      payments.set(source.id, (await supplierPaymentsService.lockPayment(client, source.id))!);
    }
  }
  for (const { source, amountMinor } of plan) {
    const left =
      source.type === "DEBIT_NOTE"
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
  if (use.source.type === "DEBIT_NOTE") {
    locked.notes.set(use.source.id, await supplierBillsService.useCredit(client, locked.notes.get(use.source.id)!, use.amountMinor, audit));
  } else {
    locked.payments.set(
      use.source.id,
      await supplierPaymentsService.useCredit(client, locked.payments.get(use.source.id)!, use.amountMinor, as, audit),
    );
  }
}

// ---------------------------------------------------------------------
// Apply credit to a bill
// ---------------------------------------------------------------------

export interface ApplyCreditRequest {
  readonly tenantId: string;
  readonly billId: string;
  readonly clientUuid: string;
  readonly amountMinor?: number | undefined;
  readonly date?: string | undefined;
  readonly sources?: readonly RequestedSource[] | undefined;
}

export async function applyCredit(request: ApplyCreditRequest, audit: AuditContext): Promise<BillDetailView> {
  const bill = await supplierBillsService.getBillRow(request.tenantId, request.billId);
  if (bill.kind !== "BILL" || (bill.status !== "ISSUED" && bill.status !== "PART_PAID")) {
    throw new DomainError("INVOICE_INVALID_STATE", `Credit is applied to posted, unpaid or part-paid bills; ${bill.number ?? "this draft"} isn't one`);
  }
  const due = supplierBillsService.balanceDue(bill);
  const date = request.date ?? todayInNairobi();
  if (date < bill.issue_date) {
    throw new ZodError([{ code: "custom", path: ["date"], message: `Credit can't be applied before the bill's date (${bill.issue_date})` }]);
  }
  const available = await listSources(request.tenantId, bill.supplier_id!);
  const totalAvailable = available.reduce((sum, s) => sum + Number(s.remaining_minor), 0);
  const requestedTotal = request.sources?.reduce((sum, s) => sum + s.amountMinor, 0);
  const amountMinor = request.amountMinor ?? requestedTotal ?? Math.min(due, totalAvailable);
  if (amountMinor === 0) {
    throw new DomainError("CREDIT_NOT_AVAILABLE", "The supplier has no credit to apply");
  }
  if (amountMinor > due) {
    throw new DomainError("INVOICE_OVERPAYMENT", `${amountMinor} is more than the ${due} still owed on ${bill.number} (minor units)`);
  }
  const plan = planUse(available, amountMinor, request.sources);
  for (const { source } of plan) {
    if (source.account_id !== bill.receivable_account_id) {
      throw new DomainError(
        "PAYMENT_ALLOCATION_INVALID",
        `${source.number}'s credit is in a different payable account from ${bill.number}; move it with a journal first`,
      );
    }
    if (source.date > date) {
      throw new ZodError([{ code: "custom", path: ["date"], message: `${source.number} is dated ${source.date}, after ${date}` }]);
    }
  }

  await withTenant(request.tenantId, async (client) => {
    let current = (await supplierBillsService.lockBill(client, bill.id))!;
    if (current.status !== "ISSUED" && current.status !== "PART_PAID") {
      throw new DomainError("INVOICE_INVALID_STATE", `${bill.number} changed meanwhile; try again`);
    }
    if (amountMinor > supplierBillsService.balanceDue(current)) {
      throw new DomainError("INVOICE_OVERPAYMENT", `${bill.number} changed meanwhile and now owes less; try again`);
    }
    const locked = await lockSources(client, plan);
    for (const [i, use] of plan.entries()) {
      const fromNote = use.source.type === "DEBIT_NOTE";
      const payment = fromNote ? null : locked.payments.get(use.source.id)!;
      const note = fromNote ? locked.notes.get(use.source.id)! : null;
      ({ invoice: current } = await supplierBillsService.applyAllocation(
        client,
        current,
        {
          // The request's clientUuid identifies the first allocation: a retry hits 409.
          clientUuid: i === 0 ? request.clientUuid : randomUUID(),
          method: fromNote ? "DEBIT_NOTE" : payment!.method,
          amountMinor: use.amountMinor,
          unappliedMinor: 0,
          date,
          reference: use.source.number,
          journalId: fromNote ? note!.journal_id! : payment!.journal_id,
          ...(fromNote ? { creditNoteId: note!.id } : { supplierPaymentId: payment!.id }),
        },
        audit,
      ));
      await useSource(client, locked, use, "APPLIED", audit);
    }
  });
  return supplierBillsService.getBill(request.tenantId, bill.id);
}

// ---------------------------------------------------------------------
// Refunds received
// ---------------------------------------------------------------------

export interface SupplierRefundSourceView {
  readonly type: "DEBIT_NOTE" | "PAYMENT";
  readonly id: string;
  readonly number: string;
  readonly amount_minor: string;
}

export type SupplierRefundView = SupplierRefundListRow;

export interface SupplierRefundDetailView extends SupplierRefundView {
  /** The credit it paid back. */
  readonly sources: SupplierRefundSourceView[];
}

function toSourceView(row: SupplierRefundSourceRow): SupplierRefundSourceView {
  return row.debit_note_id
    ? { type: "DEBIT_NOTE", id: row.debit_note_id, number: row.number, amount_minor: row.amount_minor }
    : { type: "PAYMENT", id: row.supplier_payment_id!, number: row.number, amount_minor: row.amount_minor };
}

export interface CreateRefundRequest {
  readonly tenantId: string;
  readonly clientUuid: string;
  readonly supplierId: string;
  readonly amountMinor: number;
  readonly date: string;
  readonly method: SupplierPaymentMethod;
  readonly receivedAccountId?: string | undefined;
  readonly reference?: string | undefined;
  readonly memo?: string | undefined;
  readonly sources?: readonly RequestedSource[] | undefined;
}

export async function createRefund(request: CreateRefundRequest, audit: AuditContext): Promise<SupplierRefundDetailView> {
  const [supplier, tenant] = await Promise.all([
    suppliersService.getSupplier(request.tenantId, request.supplierId),
    tenantsService.getTenant(request.tenantId),
  ]);
  const currency = supplier.currency ?? tenant.base_currency;
  const plan = planUse(await listSources(request.tenantId, supplier.id), request.amountMinor, request.sources);
  for (const { source } of plan) {
    if (source.date > request.date) {
      throw new ZodError([{ code: "custom", path: ["date"], message: `${source.number} is dated ${source.date}, after ${request.date}` }]);
    }
  }
  // A cheque from the supplier is banked.
  const receivedAccountId =
    request.receivedAccountId ??
    (await accountsService.defaultMoneyAccountId(
      request.tenantId,
      request.method === "CHEQUE" ? "BANK" : request.method,
      "receivedAccountId",
      audit,
    ));

  const narrative = `Refund from ${supplier.name}`;
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
        { accountId: receivedAccountId, debitMinor: request.amountMinor, creditMinor: 0, narrative },
        ...Array.from(byAccount, ([accountId, creditMinor]) => ({
          accountId,
          debitMinor: 0,
          creditMinor,
          narrative,
          supplierId: supplier.id,
        })),
      ],
    },
    audit,
  );

  const refundId = await withTenant(request.tenantId, async (client) => {
    const locked = await lockSources(client, plan);
    const number = await repository.nextNumber(client, request.tenantId);
    const journal = await journalsService.postPreparedJournal(
      client,
      { ...prepared, description: `Refund ${number} from ${supplier.name}`, reference: request.reference ?? number },
      audit,
    );
    const refund = await repository.insertRefund(
      client,
      {
        tenantId: request.tenantId,
        clientUuid: request.clientUuid,
        number,
        supplierId: supplier.id,
        date: request.date,
        currency,
        amountMinor: request.amountMinor,
        method: request.method,
        receivedAccountId,
        reference: request.reference ?? null,
        memo: request.memo ?? null,
        journalId: journal.id,
        sources: plan.map(({ source, amountMinor }) => ({
          debitNoteId: source.type === "DEBIT_NOTE" ? source.id : null,
          supplierPaymentId: source.type === "PAYMENT" ? source.id : null,
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

export async function getRefund(tenantId: string, id: string): Promise<SupplierRefundDetailView> {
  const row = isUuid(id) ? await repository.getRefund(tenantId, id) : null;
  if (!row) {
    throw new DomainError("SUPPLIER_REFUND_NOT_FOUND", `Refund ${id} not found`);
  }
  const sources = await repository.listSources(tenantId, [row.id]);
  return { ...row, sources: sources.map(toSourceView) };
}

export interface ListRefundsRequest {
  readonly supplierId?: string | undefined;
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

/** Newest first, without sources (GET /supplier-refunds/{id} has them). */
export async function listRefunds(tenantId: string, request: ListRefundsRequest): Promise<Page<SupplierRefundView>> {
  const rows = await repository.listRefunds(tenantId, {
    supplierId: request.supplierId,
    from: request.from,
    to: request.to,
    after: request.cursor !== undefined ? decodeCursor(request.cursor) : undefined,
    limit: request.limit,
  });
  const hasMore = rows.length > request.limit;
  const page = rows.slice(0, request.limit).map(({ sort_key: _sortKey, ...row }) => row);
  return { data: page, next_cursor: hasMore ? encodeCursor(rows[request.limit - 1]!) : null, has_more: hasMore };
}

/** The refunds posted by these journals, by journal id (supplierLedger names rows with these). */
export async function listJournalRefunds(tenantId: string, journalIds: readonly string[]): Promise<Map<string, SupplierRefundView>> {
  const refunds = await repository.listByJournalIds(tenantId, journalIds);
  return new Map(refunds.map((r) => [r.journal_id, r]));
}
