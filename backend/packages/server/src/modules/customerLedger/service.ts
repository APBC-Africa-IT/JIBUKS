/**
 * Customer ledger: a customer's history as a list of transactions with a
 * running balance -- what the Customers list's "last activity" line, the
 * customer activity report and (next) statements are built from.
 *
 * Read-only and built from the general ledger: every POSTED journal line
 * tagged with the customer, one row per journal, so the closing balance is
 * always the same figure GET /customers/{id} returns. The invoices module
 * names each row (which invoice it issued, which invoice a payment paid);
 * journals with no sales document -- opening balances, legacy credit
 * sales, manual journals -- are named from their source.
 */

import type { InvoiceKind, InvoicePaymentMethod } from "@jibuks/domain";
import * as customersService from "../customers/service.js";
import type { CustomerLedgerJournalRow, CustomerWithActivityRow, ListCustomersFilters } from "../customers/repository.js";
import * as invoicesService from "../invoices/service.js";
import type { JournalDocumentLink } from "../invoices/service.js";

export const TRANSACTION_TYPES = [
  "OPENING_BALANCE",
  "INVOICE",
  "CREDIT_NOTE",
  "INVOICE_CANCELLED",
  "CREDIT_NOTE_CANCELLED",
  "PAYMENT",
  "CREDIT_SALE",
  "REVERSAL",
  "JOURNAL",
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

interface Label {
  readonly type: TransactionType;
  readonly link: JournalDocumentLink | null;
}

const JOURNAL_SOURCE_TYPES: Readonly<Record<string, TransactionType>> = {
  OPENING: "OPENING_BALANCE",
  SALE: "CREDIT_SALE",
  PAYMENT: "PAYMENT",
  REVERSAL: "REVERSAL",
};

function labelFrom(link: JournalDocumentLink | undefined, source: string): Label {
  if (!link) {
    return { type: JOURNAL_SOURCE_TYPES[source] ?? "JOURNAL", link: null };
  }
  if (link.link === "PAYMENT") {
    return { type: "PAYMENT", link };
  }
  const credit = link.kind === "CREDIT_NOTE";
  if (link.link === "CANCEL") {
    return { type: credit ? "CREDIT_NOTE_CANCELLED" : "INVOICE_CANCELLED", link };
  }
  return { type: credit ? "CREDIT_NOTE" : "INVOICE", link };
}

/** Labels journals by id. A journal with an ISSUE or CANCEL link is named by
 * that over any PAYMENT link it also has. */
async function labelJournals(
  tenantId: string,
  journals: readonly { readonly id: string; readonly source: string }[],
): Promise<Map<string, Label>> {
  const links = await invoicesService.listJournalDocumentLinks(
    tenantId,
    journals.map((j) => j.id),
  );
  const byJournal = new Map<string, JournalDocumentLink>();
  for (const link of links) {
    const existing = byJournal.get(link.journal_id);
    if (!existing || existing.link === "PAYMENT") {
      byJournal.set(link.journal_id, link);
    }
  }
  return new Map(journals.map((j) => [j.id, labelFrom(byJournal.get(j.id), j.source)]));
}

export interface CustomerTransaction {
  readonly journal_id: string;
  readonly journal_number: string | null;
  readonly date: string;
  readonly type: TransactionType;
  /** The invoice or credit note the row issued or cancelled, or the invoice a payment was applied to. */
  readonly document_id: string | null;
  readonly document_kind: InvoiceKind | null;
  readonly document_number: string | null;
  /** CREDIT_NOTE rows: the invoice it credits. */
  readonly credited_invoice_id: string | null;
  readonly credited_invoice_number: string | null;
  /** PAYMENT rows recorded against an invoice: how it was paid and its reference (cheque number, M-Pesa code). */
  readonly payment_method: InvoicePaymentMethod | null;
  readonly reference: string | null;
  readonly description: string;
  /** What the row added to the balance (invoices, opening balances). */
  readonly debit_minor: string;
  /** What it took off (payments, credit notes, cancellations). */
  readonly credit_minor: string;
  /** The customer's balance after this row; positive = they owe the business. */
  readonly balance_minor: string;
}

export interface CustomerTransactions {
  readonly customer_id: string;
  readonly customer_name: string;
  /** Null means the business's base currency. */
  readonly currency: string | null;
  readonly from: string | null;
  readonly to: string | null;
  /** The balance before `from` (0 when from is omitted). */
  readonly opening_balance_minor: string;
  readonly total_debit_minor: string;
  readonly total_credit_minor: string;
  /** The balance at the end of the range -- equal to GET /customers/{id}?as_of=<to>. */
  readonly closing_balance_minor: string;
  readonly data: CustomerTransaction[];
}

export interface CustomerTransactionsRequest {
  readonly tenantId: string;
  readonly customerId: string;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export async function getCustomerTransactions(request: CustomerTransactionsRequest): Promise<CustomerTransactions> {
  const { tenantId, customerId, from, to } = request;
  const customer = await customersService.getCustomer(tenantId, customerId);
  const [opening, journals] = await Promise.all([
    from ? customersService.balanceBefore(tenantId, customerId, from) : Promise.resolve(0),
    customersService.listLedgerJournals(tenantId, customerId, from, to),
  ]);
  const labels = await labelJournals(
    tenantId,
    journals.map((j) => ({ id: j.journal_id, source: j.source })),
  );

  let balance = opening;
  let totalDebit = 0;
  let totalCredit = 0;
  const data = journals.map((journal: CustomerLedgerJournalRow): CustomerTransaction => {
    const debit = Number(journal.debit_minor);
    const credit = Number(journal.credit_minor);
    balance += debit - credit;
    totalDebit += debit;
    totalCredit += credit;
    const { type, link } = labels.get(journal.journal_id)!;
    const payment = link?.link === "PAYMENT" ? link : null;
    return {
      journal_id: journal.journal_id,
      journal_number: journal.journal_number,
      date: journal.date,
      type,
      document_id: link?.document_id ?? null,
      document_kind: link?.kind ?? null,
      document_number: link?.number ?? null,
      credited_invoice_id: link?.credited_invoice_id ?? null,
      credited_invoice_number: link?.credited_invoice_number ?? null,
      payment_method: payment?.method ?? null,
      reference: payment ? payment.payment_reference : journal.reference,
      description: journal.description,
      debit_minor: String(debit),
      credit_minor: String(credit),
      balance_minor: String(balance),
    };
  });

  return {
    customer_id: customer.id,
    customer_name: customer.name,
    currency: customer.currency,
    from: from ?? null,
    to: to ?? null,
    opening_balance_minor: String(opening),
    total_debit_minor: String(totalDebit),
    total_credit_minor: String(totalCredit),
    closing_balance_minor: String(balance),
    data,
  };
}

export interface LastActivity {
  readonly type: TransactionType;
  readonly date: string;
  readonly document_number: string | null;
}

export type CustomerListEntry = Omit<CustomerWithActivityRow, "last_activity_journal_id" | "last_activity_date" | "last_activity_source"> & {
  /** The customer's latest posted transaction; null if they have none. */
  readonly last_activity: LastActivity | null;
};

/** Customers with their balance and a named last activity -- what GET /customers returns. */
export async function listCustomersWithActivity(
  tenantId: string,
  filters: ListCustomersFilters,
): Promise<CustomerListEntry[]> {
  const customers = await customersService.listCustomers(tenantId, filters);
  return withLastActivity(tenantId, customers);
}

export async function getCustomerWithActivity(tenantId: string, customerId: string, asOf?: string): Promise<CustomerListEntry> {
  const customer = await customersService.getCustomer(tenantId, customerId, asOf);
  return (await withLastActivity(tenantId, [customer]))[0]!;
}

async function withLastActivity(tenantId: string, customers: readonly CustomerWithActivityRow[]): Promise<CustomerListEntry[]> {
  const labels = await labelJournals(
    tenantId,
    customers.flatMap((c) =>
      c.last_activity_journal_id ? [{ id: c.last_activity_journal_id, source: c.last_activity_source ?? "" }] : [],
    ),
  );
  return customers.map(
    ({ last_activity_journal_id: journalId, last_activity_date: date, last_activity_source: _source, ...customer }) => {
      const label = journalId ? labels.get(journalId) : undefined;
      if (!label || !date) {
        return { ...customer, last_activity: null };
      }
      return { ...customer, last_activity: { type: label.type, date, document_number: label.link?.number ?? null } };
    },
  );
}
