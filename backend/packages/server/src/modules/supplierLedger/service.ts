/**
 * Supplier ledger: a supplier's history as a list of transactions with a
 * running balance, the Suppliers list's last activity and "(Overdue)" /
 * "(Due)" tag, and the Suppliers hub's Overview tab.
 *
 * Read-only and built from the general ledger, like customerLedger: every
 * POSTED journal line tagged with the supplier, one row per journal, so the
 * closing balance is always the figure GET /suppliers/{id} returns. The
 * invoices module names each row by the bill or debit note it posted or
 * cancelled, the supplierPayments module by the payment and the bills it
 * paid; journals with no purchase document
 * -- opening balances, guided POST /bills, manual journals -- are named
 * from their source.
 *
 * A supplier's balance is what the business owes them, so a row's
 * credit_minor adds to it and debit_minor takes off it.
 */

import { daysPastDue, type InvoiceKind, type SupplierPaymentMethod } from "@jibuks/domain";
import * as documents from "../invoices/documents.js";
import { AP } from "../invoices/documents.js";
import * as invoicesService from "../invoices/service.js";
import type { JournalDocumentLink } from "../invoices/service.js";
import { todayInNairobi } from "../periods/service.js";
import * as supplierPaymentsService from "../supplierPayments/service.js";
import type { JournalPayment } from "../supplierPayments/service.js";
import * as suppliersService from "../suppliers/service.js";
import type { ListSuppliersFilters, SupplierLedgerJournalRow, SupplierWithActivityRow } from "../suppliers/repository.js";
import * as tenantsService from "../tenants/service.js";

export const SUPPLIER_TRANSACTION_TYPES = [
  "OPENING_BALANCE",
  "BILL",
  "DEBIT_NOTE",
  "BILL_CANCELLED",
  "DEBIT_NOTE_CANCELLED",
  "PAYMENT",
  "REVERSAL",
  "JOURNAL",
] as const;
export type SupplierTransactionType = (typeof SUPPLIER_TRANSACTION_TYPES)[number];

interface Label {
  readonly type: SupplierTransactionType;
  /** The bill or debit note the journal posted or cancelled. */
  readonly link: JournalDocumentLink | null;
  /** The supplier payment the journal recorded. */
  readonly payment: JournalPayment | null;
}

const JOURNAL_SOURCE_TYPES: Readonly<Record<string, SupplierTransactionType>> = {
  OPENING: "OPENING_BALANCE",
  // Guided POST /bills: a bill with no bill record.
  BILL: "BILL",
  PAYMENT: "PAYMENT",
  REVERSAL: "REVERSAL",
};

function labelFrom(link: JournalDocumentLink | undefined, payment: JournalPayment | undefined, source: string): Label {
  if (payment) {
    return { type: "PAYMENT", link: null, payment };
  }
  if (!link) {
    return { type: JOURNAL_SOURCE_TYPES[source] ?? "JOURNAL", link: null, payment: null };
  }
  const debitNote = link.kind === "DEBIT_NOTE";
  if (link.link === "CANCEL") {
    return { type: debitNote ? "DEBIT_NOTE_CANCELLED" : "BILL_CANCELLED", link, payment: null };
  }
  return { type: debitNote ? "DEBIT_NOTE" : "BILL", link, payment: null };
}

/** Labels journals by id: by the bill payment or purchase document behind each, else by its source. */
async function labelJournals(
  tenantId: string,
  journals: readonly { readonly id: string; readonly source: string }[],
): Promise<Map<string, Label>> {
  const ids = [...new Set(journals.map((j) => j.id))];
  const [links, payments] = await Promise.all([
    invoicesService.listJournalDocumentLinks(tenantId, ids, "AP"),
    supplierPaymentsService.listJournalPayments(tenantId, ids),
  ]);
  const linkByJournal = new Map(links.map((link) => [link.journal_id, link]));
  return new Map(journals.map((j) => [j.id, labelFrom(linkByJournal.get(j.id), payments.get(j.id), j.source)]));
}

/** A bill a payment row paid. */
export interface PaidBill {
  readonly bill_id: string;
  readonly bill_number: string | null;
  readonly supplier_reference: string | null;
  readonly amount_minor: string;
}

export interface SupplierTransaction {
  readonly journal_id: string;
  readonly journal_number: string | null;
  readonly date: string;
  readonly type: SupplierTransactionType;
  /** The bill or debit note the row posted or cancelled, or the supplier payment (SP-) it recorded. */
  readonly document_id: string | null;
  readonly document_kind: InvoiceKind | "SUPPLIER_PAYMENT" | null;
  readonly document_number: string | null;
  /** DEBIT_NOTE rows: the bill it was raised against. */
  readonly debited_bill_id: string | null;
  readonly debited_bill_number: string | null;
  /** PAYMENT rows: how the money moved; `reference` is its cheque number or M-Pesa code. */
  readonly payment_method: SupplierPaymentMethod | null;
  readonly reference: string | null;
  readonly description: string;
  /** PAYMENT rows: the bills it paid ([] on other rows). */
  readonly paid_bills: PaidBill[];
  /** PAYMENT rows: what wasn't applied to a bill, i.e. supplier credit (null on other rows). */
  readonly unapplied_minor: string | null;
  /** What the row added to what the business owes (bills, opening balances). */
  readonly credit_minor: string;
  /** What it took off (payments, debit notes, cancellations). */
  readonly debit_minor: string;
  /** What the business owes the supplier after this row; negative = the supplier owes the business. */
  readonly balance_minor: string;
}

function toTransaction(journal: SupplierLedgerJournalRow, label: Label, balance: number): SupplierTransaction {
  const { type, link, payment } = label;
  return {
    journal_id: journal.journal_id,
    journal_number: journal.journal_number,
    date: journal.date,
    type,
    document_id: link?.document_id ?? payment?.payment.id ?? null,
    document_kind: link?.kind ?? (payment ? "SUPPLIER_PAYMENT" : null),
    document_number: link?.number ?? payment?.payment.number ?? null,
    debited_bill_id: link?.credited_invoice_id ?? null,
    debited_bill_number: link?.credited_invoice_number ?? null,
    payment_method: payment?.payment.method ?? null,
    reference: payment ? payment.payment.reference : journal.reference,
    description: journal.description,
    paid_bills: (payment?.allocations ?? []).map((a) => ({
      bill_id: a.bill_id,
      bill_number: a.bill_number,
      supplier_reference: a.supplier_reference,
      amount_minor: a.amount_minor,
    })),
    unapplied_minor: payment ? payment.payment.unapplied_minor : null,
    credit_minor: journal.credit_minor,
    debit_minor: journal.debit_minor,
    balance_minor: String(balance),
  };
}

export interface SupplierTransactions {
  readonly supplier_id: string;
  readonly supplier_name: string;
  /** Null means the business's base currency. */
  readonly currency: string | null;
  readonly from: string | null;
  readonly to: string | null;
  /** What the business owed the supplier before `from` (0 when from is omitted). */
  readonly opening_balance_minor: string;
  readonly total_credit_minor: string;
  readonly total_debit_minor: string;
  /** The balance at the end of the range -- equal to GET /suppliers/{id}?as_of=<to>. */
  readonly closing_balance_minor: string;
  readonly data: SupplierTransaction[];
}

export interface SupplierTransactionsRequest {
  readonly tenantId: string;
  readonly supplierId: string;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export async function getSupplierTransactions(request: SupplierTransactionsRequest): Promise<SupplierTransactions> {
  const { tenantId, supplierId, from, to } = request;
  const supplier = await suppliersService.getSupplier(tenantId, supplierId);
  const [opening, journals] = await Promise.all([
    from ? suppliersService.balanceBefore(tenantId, supplierId, from) : Promise.resolve(0),
    suppliersService.listLedgerJournals(tenantId, supplierId, from, to),
  ]);
  const labels = await labelJournals(
    tenantId,
    journals.map((j) => ({ id: j.journal_id, source: j.source })),
  );

  let balance = opening;
  let totalCredit = 0;
  let totalDebit = 0;
  const data = journals.map((journal) => {
    const credit = Number(journal.credit_minor);
    const debit = Number(journal.debit_minor);
    balance += credit - debit;
    totalCredit += credit;
    totalDebit += debit;
    return toTransaction(journal, labels.get(journal.journal_id)!, balance);
  });

  return {
    supplier_id: supplier.id,
    supplier_name: supplier.name,
    currency: supplier.currency,
    from: from ?? null,
    to: to ?? null,
    opening_balance_minor: String(opening),
    total_credit_minor: String(totalCredit),
    total_debit_minor: String(totalDebit),
    closing_balance_minor: String(balance),
    data,
  };
}

export interface LastActivity {
  readonly type: SupplierTransactionType;
  readonly date: string;
  readonly document_number: string | null;
}

/** OVERDUE: a posted bill is past due. DUE: owed, nothing past due. CREDIT: the supplier owes the business. SETTLED: nothing either way. */
export type PaymentStatus = "OVERDUE" | "DUE" | "CREDIT" | "SETTLED";

export type SupplierEntry = Omit<SupplierWithActivityRow, "last_activity_journal_id" | "last_activity_date" | "last_activity_source"> & {
  /** The supplier's latest posted transaction; null if they have none. */
  readonly last_activity: LastActivity | null;
  /** What is past due on posted bills at as_of. */
  readonly overdue_minor: string;
  readonly payment_status: PaymentStatus;
};

/** The number a row shows: the bill's or debit note's, or the payment's (SP-). */
function documentNumberOf(label: Label): string | null {
  return label.link?.number ?? label.payment?.payment.number ?? null;
}

/** Adds the last activity and the list's "(Overdue)" / "(Due)" tag. */
async function toEntries(
  tenantId: string,
  suppliers: readonly SupplierWithActivityRow[],
  asOf: string,
  supplierId?: string,
): Promise<SupplierEntry[]> {
  const [labels, open] = await Promise.all([
    labelJournals(
      tenantId,
      suppliers.flatMap((s) =>
        s.last_activity_journal_id ? [{ id: s.last_activity_journal_id, source: s.last_activity_source ?? "" }] : [],
      ),
    ),
    documents.listOpenAsOf(AP, tenantId, asOf, supplierId),
  ]);
  const overdue = new Map<string, number>();
  for (const bill of open) {
    if (daysPastDue(bill.due_date ?? bill.issue_date, asOf) > 0) {
      overdue.set(bill.party_id, (overdue.get(bill.party_id) ?? 0) + Number(bill.open_minor));
    }
  }
  return suppliers.map(
    ({ last_activity_journal_id: journalId, last_activity_date: date, last_activity_source: _source, ...supplier }) => {
      const label = journalId ? labels.get(journalId) : undefined;
      const overdueMinor = overdue.get(supplier.id) ?? 0;
      const balance = Number(supplier.balance_minor);
      const paymentStatus: PaymentStatus =
        overdueMinor > 0 ? "OVERDUE" : balance > 0 ? "DUE" : balance < 0 ? "CREDIT" : "SETTLED";
      return {
        ...supplier,
        last_activity: label && date ? { type: label.type, date, document_number: documentNumberOf(label) } : null,
        overdue_minor: String(overdueMinor),
        payment_status: paymentStatus,
      };
    },
  );
}

/** What GET /suppliers returns. */
export async function listSupplierEntries(tenantId: string, filters: ListSuppliersFilters): Promise<SupplierEntry[]> {
  const suppliers = await suppliersService.listSuppliers(tenantId, filters);
  return toEntries(tenantId, suppliers, filters.asOf ?? todayInNairobi());
}

/** What GET /suppliers/{id} (and POST /suppliers) returns. */
export async function getSupplierEntry(tenantId: string, supplierId: string, asOf?: string): Promise<SupplierEntry> {
  const supplier = await suppliersService.getSupplier(tenantId, supplierId, asOf);
  return (await toEntries(tenantId, [supplier], asOf ?? todayInNairobi(), supplier.id))[0]!;
}

export interface RecentSupplierActivity extends Omit<SupplierTransaction, "balance_minor"> {
  readonly supplier_id: string;
  readonly supplier_name: string;
}

export interface PayablesOverview {
  readonly as_of: string;
  readonly currency: string;
  /** Everything the business owes its suppliers, net of supplier credit -- the same total as GET /payables-aging. */
  readonly total_payables_minor: string;
  /** Owed on posted bills past their due date. */
  readonly overdue_minor: string;
  readonly overdue_bill_count: number;
  readonly due_soon_days: number;
  /** Owed on posted bills due from as_of to as_of + due_soon_days, not yet overdue. */
  readonly due_soon_minor: string;
  readonly due_soon_bill_count: number;
  /** The latest supplier transactions, newest first. */
  readonly recent_activity: RecentSupplierActivity[];
}

export interface PayablesOverviewRequest {
  readonly tenantId: string;
  readonly asOf?: string | undefined;
  readonly dueSoonDays: number;
  readonly recentLimit: number;
}

/** The Suppliers hub's Overview tab: Total Payables, Overdue, Due Soon and Recent Supplier Activity. */
export async function getPayablesOverview(request: PayablesOverviewRequest): Promise<PayablesOverview> {
  const { tenantId, dueSoonDays, recentLimit } = request;
  const asOf = request.asOf ?? todayInNairobi();
  const [tenant, suppliers, open, recent] = await Promise.all([
    tenantsService.getTenant(tenantId),
    suppliersService.listSuppliers(tenantId, { asOf }),
    documents.listOpenAsOf(AP, tenantId, asOf),
    suppliersService.listRecentLedgerJournals(tenantId, asOf, recentLimit),
  ]);

  let overdue = 0;
  let overdueCount = 0;
  let dueSoon = 0;
  let dueSoonCount = 0;
  for (const bill of open) {
    const days = daysPastDue(bill.due_date ?? bill.issue_date, asOf);
    if (days > 0) {
      overdue += Number(bill.open_minor);
      overdueCount += 1;
    } else if (-days <= dueSoonDays) {
      dueSoon += Number(bill.open_minor);
      dueSoonCount += 1;
    }
  }

  const names = new Map(suppliers.map((s) => [s.id, s.name]));
  const labels = await labelJournals(
    tenantId,
    recent.map((j) => ({ id: j.journal_id, source: j.source })),
  );

  return {
    as_of: asOf,
    currency: tenant.base_currency,
    total_payables_minor: String(suppliers.reduce((sum, s) => sum + Number(s.balance_minor), 0)),
    overdue_minor: String(overdue),
    overdue_bill_count: overdueCount,
    due_soon_days: dueSoonDays,
    due_soon_minor: String(dueSoon),
    due_soon_bill_count: dueSoonCount,
    recent_activity: recent.map((journal) => {
      const { balance_minor: _balance, ...row } = toTransaction(journal, labels.get(journal.journal_id)!, 0);
      return { supplier_id: journal.supplier_id, supplier_name: names.get(journal.supplier_id) ?? "", ...row };
    }),
  };
}
