/**
 * Customer payments -- the Receive Payment screen, and every other way
 * money from a customer is recorded against invoices (POST
 * /invoices/{id}/payments, M-Pesa collections).
 *
 * A payment is for a customer, not an invoice. In ONE transaction it takes
 * the next PMT- number, posts one journal
 *   Dr money account (amount)
 *     Cr receivables, tagged with the customer (amount; split by each
 *        invoice's receivable account, credit to the business's default)
 * and applies it to the invoices it pays. By default (no allocations sent)
 * that is the customer's open invoices, oldest due date first -- the usual
 * "pay the oldest first" rule. Whatever isn't applied stays on the payment
 * as unapplied_minor: customer credit, already counted in their balance.
 */

import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { DomainError, isUuid, type CurrencyCode, type InvoicePaymentMethod } from "@jibuks/domain";
import { withTenant, type AuditContext } from "@jibuks/db";
import * as accountsService from "../accounts/service.js";
import * as customersService from "../customers/service.js";
import * as invoicesService from "../invoices/service.js";
import type { InvoiceRow } from "../invoices/service.js";
import * as journalsService from "../journals/service.js";
import type { CreateJournalLineRequest } from "../journals/service.js";
import * as tenantsService from "../tenants/service.js";
import * as repository from "./repository.js";
import type { CustomerPaymentListRow, PaymentAllocationRow } from "./repository.js";

export interface PaymentAllocationView {
  readonly invoice_id: string;
  readonly invoice_number: string;
  readonly amount_minor: string;
  readonly date: string;
}

export type CustomerPaymentView = CustomerPaymentListRow;

export interface CustomerPaymentDetailView extends CustomerPaymentView {
  /** The invoices it was applied to, oldest due first. */
  readonly allocations: PaymentAllocationView[];
}

function toAllocationView(row: PaymentAllocationRow): PaymentAllocationView {
  return { invoice_id: row.invoice_id, invoice_number: row.invoice_number, amount_minor: row.amount_minor, date: row.date };
}

/**
 * How a requested allocation that doesn't fit is handled.
 * REFUSE: 422 (the screens -- the user can fix it).
 * CREDIT: apply what fits and keep the rest as credit (M-Pesa collections:
 *         the money has already arrived).
 */
export type OverpaymentRule = "REFUSE" | "CREDIT";

export interface ReceivePaymentRequest {
  readonly tenantId: string;
  /** Identity of the payment and of its journal. */
  readonly clientUuid: string;
  readonly customerId: string;
  readonly amountMinor: number;
  readonly date: string;
  readonly method: InvoicePaymentMethod;
  readonly receivedAccountId?: string | undefined;
  readonly reference?: string | undefined;
  readonly memo?: string | undefined;
  /** Omitted: the customer's open invoices, oldest due first. [] keeps it all as credit. */
  readonly allocations?: readonly { readonly invoiceId: string; readonly amountMinor: number }[] | undefined;
  readonly overpayment?: OverpaymentRule;
  /** Set for an M-Pesa collection (payments module). */
  readonly paymentId?: string | undefined;
}

interface PlannedAllocation {
  readonly invoice: InvoiceRow;
  readonly amountMinor: number;
}


function isPayable(invoice: InvoiceRow): boolean {
  return invoice.kind === "INVOICE" && (invoice.status === "ISSUED" || invoice.status === "PART_PAID");
}

/** Oldest due first, as far as the money goes; `invoices` are all the open ones. */
async function planOldestFirst(tenantId: string, customerId: string, currency: string, amountMinor: number) {
  const open = (await invoicesService.listPayableInvoices(tenantId, customerId)).filter((i) => i.currency === currency);
  const plan: PlannedAllocation[] = [];
  let remaining = amountMinor;
  for (const invoice of open) {
    if (remaining === 0) break;
    const take = Math.min(remaining, invoicesService.balanceDue(invoice));
    if (take > 0) {
      plan.push({ invoice, amountMinor: take });
      remaining -= take;
    }
  }
  return { plan, invoices: open };
}

/** The requested allocations, checked; `invoices` are every invoice named, applied to or not. */
async function planRequested(
  request: ReceivePaymentRequest,
  currency: string,
  allocations: readonly { readonly invoiceId: string; readonly amountMinor: number }[],
): Promise<{ plan: PlannedAllocation[]; invoices: InvoiceRow[] }> {
  const rule = request.overpayment ?? "REFUSE";
  const plan: PlannedAllocation[] = [];
  const invoices: InvoiceRow[] = [];
  for (const requested of allocations) {
    const invoice = await invoicesService.getInvoiceRow(request.tenantId, requested.invoiceId);
    invoices.push(invoice);
    const label = invoice.number ?? "This draft";
    if (invoice.customer_id !== request.customerId) {
      throw new DomainError("PAYMENT_ALLOCATION_INVALID", `${label} belongs to a different customer`);
    }
    if (invoice.currency !== currency) {
      throw new DomainError("PAYMENT_ALLOCATION_INVALID", `${label} is in ${invoice.currency}; the payment is in ${currency}`);
    }
    const due = isPayable(invoice) ? invoicesService.balanceDue(invoice) : 0;
    if (rule === "REFUSE") {
      if (!isPayable(invoice)) {
        throw new DomainError(
          "INVOICE_INVALID_STATE",
          invoice.kind === "INVOICE"
            ? `${label} is ${invoice.status.toLowerCase()}; payments are made against issued invoices`
            : `Payments are made against invoices, not a ${invoice.kind.toLowerCase().replace("_", " ")}`,
        );
      }
      if (requested.amountMinor > due) {
        throw new DomainError("INVOICE_OVERPAYMENT", `${requested.amountMinor} is more than the ${due} still owed on ${label} (minor units)`);
      }
    }
    const take = Math.min(requested.amountMinor, due);
    if (take > 0) {
      plan.push({ invoice, amountMinor: take });
    }
  }
  return { plan, invoices };
}

/** Cr lines: what each invoice takes, by its receivable account, and the credit to `creditAccountId`. */
function receivableLines(
  plan: readonly PlannedAllocation[],
  unappliedMinor: number,
  creditAccountId: string | null,
  customerId: string,
  narrative: string,
): CreateJournalLineRequest[] {
  const byAccount = new Map<string, number>();
  for (const { invoice, amountMinor } of plan) {
    const account = invoice.receivable_account_id!;
    byAccount.set(account, (byAccount.get(account) ?? 0) + amountMinor);
  }
  if (unappliedMinor > 0) {
    byAccount.set(creditAccountId!, (byAccount.get(creditAccountId!) ?? 0) + unappliedMinor);
  }
  return Array.from(byAccount, ([accountId, creditMinor]) => ({ accountId, debitMinor: 0, creditMinor, narrative, customerId }));
}

export async function receivePayment(request: ReceivePaymentRequest, audit: AuditContext): Promise<CustomerPaymentDetailView> {
  const [customer, tenant] = await Promise.all([
    customersService.getCustomer(request.tenantId, request.customerId),
    tenantsService.getTenant(request.tenantId),
  ]);
  const currency = customer.currency ?? tenant.base_currency;
  const { plan, invoices } = request.allocations
    ? await planRequested(request, currency, request.allocations)
    : await planOldestFirst(request.tenantId, customer.id, currency, request.amountMinor);
  const appliedMinor = plan.reduce((sum, p) => sum + p.amountMinor, 0);
  const unappliedMinor = request.amountMinor - appliedMinor;

  const receivedAccountId =
    request.receivedAccountId ??
    (await accountsService.defaultMoneyAccountId(request.tenantId, request.method, "receivedAccountId", audit));
  // Credit sits in the receivable account of the invoices the money was for,
  // else of the customer's open invoices, else the business's default one.
  let creditAccountId: string | null = null;
  if (unappliedMinor > 0) {
    creditAccountId =
      invoices[0]?.receivable_account_id ??
      (await invoicesService.listPayableInvoices(request.tenantId, customer.id))[0]?.receivable_account_id ??
      (await invoicesService.defaultReceivableAccountId(request.tenantId));
  }
  const narrative = `Payment from ${customer.name}`;
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
        ...receivableLines(plan, unappliedMinor, creditAccountId, customer.id, narrative),
      ],
    },
    audit,
  );

  const paymentId = await withTenant(request.tenantId, async (client) => {
    // Lock in id order so two payments to the same invoices can't deadlock.
    const locked = new Map<string, InvoiceRow>();
    for (const { invoice } of [...plan].sort((a, b) => a.invoice.id.localeCompare(b.invoice.id))) {
      locked.set(invoice.id, (await invoicesService.lockInvoice(client, invoice.id))!);
    }
    for (const { invoice, amountMinor } of plan) {
      const now = locked.get(invoice.id)!;
      if (!isPayable(now) || amountMinor > invoicesService.balanceDue(now)) {
        throw new DomainError("INVOICE_INVALID_STATE", `${invoice.number} changed while the payment was being recorded; try again`);
      }
    }

    const number = await repository.nextNumber(client, request.tenantId);
    const journal = await journalsService.postPreparedJournal(
      client,
      { ...prepared, description: `Payment ${number} from ${customer.name}`, reference: request.reference ?? number },
      audit,
    );
    const payment = await repository.insertPayment(
      client,
      {
        tenantId: request.tenantId,
        clientUuid: request.clientUuid,
        number,
        customerId: customer.id,
        date: request.date,
        currency,
        amountMinor: request.amountMinor,
        appliedMinor,
        method: request.method,
        receivedAccountId,
        reference: request.reference ?? null,
        memo: request.memo ?? null,
        journalId: journal.id,
        paymentId: request.paymentId ?? null,
        creditAccountId,
      },
      audit,
    );
    for (const { invoice, amountMinor } of plan) {
      await invoicesService.applyAllocation(
        client,
        locked.get(invoice.id)!,
        {
          clientUuid: randomUUID(),
          method: request.method,
          amountMinor,
          unappliedMinor: 0,
          date: request.date,
          receivedAccountId,
          ...(request.reference !== undefined ? { reference: request.reference } : {}),
          journalId: journal.id,
          ...(request.paymentId !== undefined ? { paymentId: request.paymentId } : {}),
          customerPaymentId: payment.id,
        },
        audit,
      );
    }
    return payment.id;
  });
  return getPayment(request.tenantId, paymentId);
}

export async function getPayment(tenantId: string, id: string): Promise<CustomerPaymentDetailView> {
  const row = isUuid(id) ? await repository.getPayment(tenantId, id) : null;
  if (!row) {
    throw new DomainError("CUSTOMER_PAYMENT_NOT_FOUND", `Payment ${id} not found`);
  }
  const allocations = await repository.listAllocations(tenantId, [row.id]);
  return { ...row, allocations: allocations.map(toAllocationView) };
}

export interface ListPaymentsRequest {
  readonly customerId?: string | undefined;
  readonly method?: InvoicePaymentMethod | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly hasCredit?: boolean | undefined;
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

/** Newest first, without allocations (GET /customer-payments/{id} has them). */
export async function listPayments(tenantId: string, request: ListPaymentsRequest): Promise<Page<CustomerPaymentView>> {
  const rows = await repository.listPayments(tenantId, {
    customerId: request.customerId,
    method: request.method,
    from: request.from,
    to: request.to,
    hasCredit: request.hasCredit,
    q: request.q,
    after: request.cursor !== undefined ? decodeCursor(request.cursor) : undefined,
    limit: request.limit,
  });
  const hasMore = rows.length > request.limit;
  const page = rows.slice(0, request.limit).map(({ sort_key: _sortKey, ...row }) => row);
  return {
    data: page,
    next_cursor: hasMore ? encodeCursor(rows[request.limit - 1]!) : null,
    has_more: hasMore,
  };
}

/** The M-Pesa collection's payment, if it has been recorded (payments module). */
export async function findByPaymentId(tenantId: string, paymentId: string): Promise<CustomerPaymentView | null> {
  return repository.findByPaymentId(tenantId, paymentId);
}

export interface JournalPayment {
  readonly payment: CustomerPaymentView;
  readonly allocations: PaymentAllocationView[];
}

/** The payments posted by these journals, with what each was applied to (customerLedger names rows with these). */
export async function listJournalPayments(tenantId: string, journalIds: readonly string[]): Promise<Map<string, JournalPayment>> {
  const payments = await repository.listByJournalIds(tenantId, journalIds);
  const allocations = await repository.listAllocations(
    tenantId,
    payments.map((p) => p.id),
  );
  return new Map(
    payments.map((payment) => [
      payment.journal_id,
      {
        payment,
        allocations: allocations.filter((a) => a.customer_payment_id === payment.id).map(toAllocationView),
      },
    ]),
  );
}

// ---------------------------------------------------------------------
// Credit -- primitives for the customerCredits module.
// ---------------------------------------------------------------------

export type CustomerPaymentRow = repository.CustomerPaymentRow;

/** The customer's payments with credit left on them, oldest first. */
export async function listWithCredit(tenantId: string, customerId: string): Promise<CustomerPaymentView[]> {
  return repository.listWithCredit(tenantId, customerId);
}

/** Locks a payment row for the rest of the transaction. */
export const lockPayment = repository.lockPayment;

/** Moves some of a locked payment's credit to applied or refunded. */
export const useCredit = repository.useCredit;
