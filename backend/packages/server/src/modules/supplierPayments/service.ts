/**
 * Supplier payments -- the Pay Bills screen, and every other way money
 * paid to a supplier is recorded against bills (POST
 * /supplier-bills/{id}/payments).
 *
 * A payment is for a supplier, not a bill. In ONE transaction it takes the
 * next SP- number, posts one journal
 *   Dr payables, tagged with the supplier (amount; split by each bill's
 *      payable account, credit to the bills' or the business's default)
 *     Cr money account (amount)
 * and applies it to the bills it pays. By default (no allocations sent)
 * that is the supplier's open bills, oldest due date first. Whatever isn't
 * applied stays on the payment as unapplied_minor: supplier credit (an
 * advance), already counted in their balance.
 */

import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { DomainError, isUuid, type CurrencyCode, type SupplierPaymentMethod } from "@jibuks/domain";
import { withTenant, type AuditContext } from "@jibuks/db";
import * as accountsService from "../accounts/service.js";
import * as journalsService from "../journals/service.js";
import type { CreateJournalLineRequest } from "../journals/service.js";
import * as supplierBillsService from "../supplierBills/service.js";
import type { BillRow } from "../supplierBills/service.js";
import * as suppliersService from "../suppliers/service.js";
import * as tenantsService from "../tenants/service.js";
import * as repository from "./repository.js";
import type { PaymentAllocationRow, SupplierPaymentListRow } from "./repository.js";

export interface PaymentAllocationView {
  readonly bill_id: string;
  readonly bill_number: string;
  /** The supplier's own invoice number on the bill. */
  readonly supplier_reference: string | null;
  readonly amount_minor: string;
  readonly date: string;
}

export type SupplierPaymentView = SupplierPaymentListRow;

export interface SupplierPaymentDetailView extends SupplierPaymentView {
  /** The bills it was applied to, oldest due first. */
  readonly allocations: PaymentAllocationView[];
}

function toAllocationView(row: PaymentAllocationRow): PaymentAllocationView {
  return {
    bill_id: row.bill_id,
    bill_number: row.bill_number,
    supplier_reference: row.supplier_reference,
    amount_minor: row.amount_minor,
    date: row.date,
  };
}

export interface MakePaymentRequest {
  readonly tenantId: string;
  /** Identity of the payment and of its journal. */
  readonly clientUuid: string;
  readonly supplierId: string;
  readonly amountMinor: number;
  readonly date: string;
  readonly method: SupplierPaymentMethod;
  readonly paidFromAccountId?: string | undefined;
  readonly reference?: string | undefined;
  readonly memo?: string | undefined;
  /** Omitted: the supplier's open bills, oldest due first. [] keeps it all as credit. */
  readonly allocations?: readonly { readonly billId: string; readonly amountMinor: number }[] | undefined;
}

interface PlannedAllocation {
  readonly bill: BillRow;
  readonly amountMinor: number;
}

function isPayable(bill: BillRow): boolean {
  return bill.kind === "BILL" && (bill.status === "ISSUED" || bill.status === "PART_PAID");
}

/** Oldest due first, as far as the money goes; `bills` are all the open ones. */
async function planOldestFirst(tenantId: string, supplierId: string, currency: string, amountMinor: number) {
  const open = (await supplierBillsService.listPayableBills(tenantId, supplierId)).filter((b) => b.currency === currency);
  const plan: PlannedAllocation[] = [];
  let remaining = amountMinor;
  for (const bill of open) {
    if (remaining === 0) break;
    const take = Math.min(remaining, supplierBillsService.balanceDue(bill));
    if (take > 0) {
      plan.push({ bill, amountMinor: take });
      remaining -= take;
    }
  }
  return { plan, bills: open };
}

/** The requested allocations, checked; `bills` are every bill named. */
async function planRequested(
  request: MakePaymentRequest,
  currency: string,
  allocations: readonly { readonly billId: string; readonly amountMinor: number }[],
): Promise<{ plan: PlannedAllocation[]; bills: BillRow[] }> {
  const plan: PlannedAllocation[] = [];
  const bills: BillRow[] = [];
  for (const requested of allocations) {
    const bill = await supplierBillsService.getBillRow(request.tenantId, requested.billId);
    bills.push(bill);
    const label = bill.number ?? "This draft";
    if (bill.supplier_id !== request.supplierId) {
      throw new DomainError("PAYMENT_ALLOCATION_INVALID", `${label} belongs to a different supplier`);
    }
    if (bill.currency !== currency) {
      throw new DomainError("PAYMENT_ALLOCATION_INVALID", `${label} is in ${bill.currency}; the payment is in ${currency}`);
    }
    if (!isPayable(bill)) {
      throw new DomainError(
        "INVOICE_INVALID_STATE",
        bill.kind === "BILL"
          ? `${label} is ${bill.status.toLowerCase()}; payments are made against posted bills`
          : "Payments are made against bills, not a debit note",
      );
    }
    const due = supplierBillsService.balanceDue(bill);
    if (requested.amountMinor > due) {
      throw new DomainError("INVOICE_OVERPAYMENT", `${requested.amountMinor} is more than the ${due} still owed on ${label} (minor units)`);
    }
    plan.push({ bill, amountMinor: requested.amountMinor });
  }
  return { plan, bills };
}

/** Dr lines: what each bill takes, by its payable account, and the credit to `creditAccountId`. */
function payableLines(
  plan: readonly PlannedAllocation[],
  unappliedMinor: number,
  creditAccountId: string | null,
  supplierId: string,
  narrative: string,
): CreateJournalLineRequest[] {
  const byAccount = new Map<string, number>();
  for (const { bill, amountMinor } of plan) {
    const account = bill.receivable_account_id!; // the bill's payable account
    byAccount.set(account, (byAccount.get(account) ?? 0) + amountMinor);
  }
  if (unappliedMinor > 0) {
    byAccount.set(creditAccountId!, (byAccount.get(creditAccountId!) ?? 0) + unappliedMinor);
  }
  return Array.from(byAccount, ([accountId, debitMinor]) => ({ accountId, debitMinor, creditMinor: 0, narrative, supplierId }));
}

/** A cheque leaves the bank. */
function moneyMethod(method: SupplierPaymentMethod) {
  return method === "CHEQUE" ? "BANK" : method;
}

export async function makePayment(request: MakePaymentRequest, audit: AuditContext): Promise<SupplierPaymentDetailView> {
  const [supplier, tenant] = await Promise.all([
    suppliersService.getSupplier(request.tenantId, request.supplierId),
    tenantsService.getTenant(request.tenantId),
  ]);
  const currency = supplier.currency ?? tenant.base_currency;
  const { plan, bills } = request.allocations
    ? await planRequested(request, currency, request.allocations)
    : await planOldestFirst(request.tenantId, supplier.id, currency, request.amountMinor);
  const appliedMinor = plan.reduce((sum, p) => sum + p.amountMinor, 0);
  const unappliedMinor = request.amountMinor - appliedMinor;

  const paidFromAccountId =
    request.paidFromAccountId ??
    (await accountsService.defaultMoneyAccountId(request.tenantId, moneyMethod(request.method), "paidFromAccountId", audit));
  // Credit sits in the payable account of the bills the money was for,
  // else of the supplier's open bills, else the business's default one.
  let creditAccountId: string | null = null;
  if (unappliedMinor > 0) {
    creditAccountId =
      bills[0]?.receivable_account_id ??
      (await supplierBillsService.listPayableBills(request.tenantId, supplier.id))[0]?.receivable_account_id ??
      (await supplierBillsService.defaultPayableAccountId(request.tenantId));
  }
  const narrative = `Payment to ${supplier.name}`;
  const prepared = await journalsService.prepareJournal(
    {
      tenantId: request.tenantId,
      clientUuid: request.clientUuid,
      date: request.date,
      currency: currency as CurrencyCode,
      description: narrative, // numbered inside the transaction
      source: "PAYMENT",
      lines: [
        ...payableLines(plan, unappliedMinor, creditAccountId, supplier.id, narrative),
        { accountId: paidFromAccountId, debitMinor: 0, creditMinor: request.amountMinor, narrative },
      ],
    },
    audit,
  );

  const paymentId = await withTenant(request.tenantId, async (client) => {
    // Lock in id order so two payments to the same bills can't deadlock.
    const locked = new Map<string, BillRow>();
    for (const { bill } of [...plan].sort((a, b) => a.bill.id.localeCompare(b.bill.id))) {
      locked.set(bill.id, (await supplierBillsService.lockBill(client, bill.id))!);
    }
    for (const { bill, amountMinor } of plan) {
      const now = locked.get(bill.id)!;
      if (!isPayable(now) || amountMinor > supplierBillsService.balanceDue(now)) {
        throw new DomainError("INVOICE_INVALID_STATE", `${bill.number} changed while the payment was being recorded; try again`);
      }
    }

    const number = await repository.nextNumber(client, request.tenantId);
    const journal = await journalsService.postPreparedJournal(
      client,
      { ...prepared, description: `Payment ${number} to ${supplier.name}`, reference: request.reference ?? number },
      audit,
    );
    const payment = await repository.insertPayment(
      client,
      {
        tenantId: request.tenantId,
        clientUuid: request.clientUuid,
        number,
        supplierId: supplier.id,
        date: request.date,
        currency,
        amountMinor: request.amountMinor,
        appliedMinor,
        method: request.method,
        paidFromAccountId,
        reference: request.reference ?? null,
        memo: request.memo ?? null,
        journalId: journal.id,
        creditAccountId,
      },
      audit,
    );
    for (const { bill, amountMinor } of plan) {
      await supplierBillsService.applyAllocation(
        client,
        locked.get(bill.id)!,
        {
          clientUuid: randomUUID(),
          method: request.method,
          amountMinor,
          unappliedMinor: 0,
          date: request.date,
          receivedAccountId: paidFromAccountId,
          ...(request.reference !== undefined ? { reference: request.reference } : {}),
          journalId: journal.id,
          supplierPaymentId: payment.id,
        },
        audit,
      );
    }
    return payment.id;
  });
  return getPayment(request.tenantId, paymentId);
}

export async function getPayment(tenantId: string, id: string): Promise<SupplierPaymentDetailView> {
  const row = isUuid(id) ? await repository.getPayment(tenantId, id) : null;
  if (!row) {
    throw new DomainError("SUPPLIER_PAYMENT_NOT_FOUND", `Payment ${id} not found`);
  }
  const allocations = await repository.listAllocations(tenantId, [row.id]);
  return { ...row, allocations: allocations.map(toAllocationView) };
}

export interface ListPaymentsRequest {
  readonly supplierId?: string | undefined;
  readonly method?: SupplierPaymentMethod | undefined;
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

/** Newest first, without allocations (GET /supplier-payments/{id} has them). */
export async function listPayments(tenantId: string, request: ListPaymentsRequest): Promise<Page<SupplierPaymentView>> {
  const rows = await repository.listPayments(tenantId, {
    supplierId: request.supplierId,
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

export interface JournalPayment {
  readonly payment: SupplierPaymentView;
  readonly allocations: PaymentAllocationView[];
}

/** The payments posted by these journals, with what each was applied to (supplierLedger names rows with these). */
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
        allocations: allocations.filter((a) => a.supplier_payment_id === payment.id).map(toAllocationView),
      },
    ]),
  );
}
