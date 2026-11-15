/**
 * Cash purchases service -- goods or services bought and paid for on the
 * spot (PUR-000001), the Suppliers hub's Cash Purchase screen. The supplier
 * side of a cash sale.
 *
 * Settled when written, so like a cheque it has no draft: one request
 * validates it, then in ONE transaction takes the next PUR- number, posts
 * the journal and stores the purchase already PAID:
 *   Dr line account(s) (net) -- expense, stock (an item's inventory
 *                               account) or any other account
 *   Dr input VAT (by VAT account)
 *     Cr Accounts Payable, tagged with the supplier (total)  } only with a
 *   Dr Accounts Payable, tagged with the supplier (total)    } supplier
 *     Cr the money account (total)
 * The two payables lines cancel out, so the supplier's balance and aging
 * don't move, but the purchase shows in their history and activity. With
 * no supplier (a one-off seller) the lines go straight to the money account.
 */

import { randomUUID } from "node:crypto";
import { DomainError, formatInvoiceNumber, type CurrencyCode, type SupplierPaymentMethod, type TaxMode } from "@jibuks/domain";
import { withTenant, type AuditContext } from "@jibuks/db";
import * as accountsService from "../accounts/service.js";
import * as documents from "../invoices/documents.js";
import { CASH_PURCHASES, type DocumentDetail, type DocumentView, type Page } from "../invoices/documents.js";
import * as repository from "../invoices/repository.js";
import type { InvoiceLineRow } from "../invoices/repository.js";
import type { CreateJournalLineRequest } from "../journals/service.js";
import * as journalsService from "../journals/service.js";
import { todayInNairobi } from "../periods/service.js";
import * as suppliersService from "../suppliers/service.js";
import * as tenantsService from "../tenants/service.js";

// ---------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------

export interface CashPurchaseLineView {
  readonly id: string;
  readonly line_no: number;
  readonly item_id: string | null;
  readonly account_id: string;
  readonly description: string | null;
  readonly quantity: string;
  readonly unit_price_minor: string;
  /** The total as entered; null when the line was priced per unit. */
  readonly amount_minor: string | null;
  readonly tax_rate_bps: number;
  readonly tax_account_id: string | null;
  readonly net_minor: string;
  readonly tax_minor: string;
  readonly total_minor: string;
}

export interface CashPurchaseView {
  readonly id: string;
  readonly client_uuid: string;
  readonly branch_id: string | null;
  /** PUR-000001 -- the business's own gapless number. */
  readonly number: string;
  readonly status: string;
  readonly supplier_id: string | null;
  readonly supplier_name: string | null;
  /** The seller's receipt or invoice number. */
  readonly supplier_reference: string | null;
  readonly date: string;
  readonly currency: string;
  readonly payment_method: SupplierPaymentMethod;
  readonly paid_from_account_id: string;
  /** With a supplier: the payables the purchase passed through; null without one. */
  readonly payable_account_id: string | null;
  readonly tax_mode: TaxMode;
  readonly subtotal_minor: string;
  readonly tax_minor: string;
  readonly total_minor: string;
  readonly reference: string | null;
  readonly memo: string | null;
  readonly journal_id: string;
  readonly created_by: string;
  readonly created_at: string;
}

export interface CashPurchaseDetailView extends CashPurchaseView {
  readonly lines: CashPurchaseLineView[];
}

function toView(v: DocumentView): CashPurchaseView {
  return {
    id: v.id,
    client_uuid: v.client_uuid,
    branch_id: v.branch_id,
    number: v.number!,
    status: v.status,
    supplier_id: v.supplier_id,
    supplier_name: v.party_name,
    supplier_reference: v.supplier_reference,
    date: v.issue_date,
    currency: v.currency,
    payment_method: v.payment_method!,
    paid_from_account_id: v.deposit_account_id!,
    payable_account_id: v.receivable_account_id,
    tax_mode: v.tax_mode,
    subtotal_minor: v.subtotal_minor,
    tax_minor: v.tax_minor,
    total_minor: v.total_minor,
    reference: v.reference,
    memo: v.memo,
    journal_id: v.journal_id!,
    created_by: v.created_by,
    created_at: v.created_at,
  };
}

function toLineView(l: InvoiceLineRow): CashPurchaseLineView {
  return {
    id: l.id,
    line_no: l.line_no,
    item_id: l.item_id,
    account_id: l.income_account_id,
    description: l.description !== "" ? l.description : null,
    quantity: l.quantity,
    unit_price_minor: l.unit_price_minor,
    amount_minor: l.amount_minor,
    tax_rate_bps: l.tax_rate_bps,
    tax_account_id: l.tax_account_id,
    net_minor: l.net_minor,
    tax_minor: l.tax_minor,
    total_minor: l.total_minor,
  };
}

function toDetail(detail: DocumentDetail): CashPurchaseDetailView {
  const { lines, allocations: _allocations, ...view } = detail;
  return { ...toView(view), lines: lines.map(toLineView) };
}

export async function getCashPurchase(tenantId: string, id: string): Promise<CashPurchaseDetailView> {
  return toDetail(await documents.getDetail(CASH_PURCHASES, tenantId, id));
}

export interface ListCashPurchasesRequest {
  readonly supplierId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly q?: string;
  readonly limit: number;
  readonly cursor?: string;
}

export async function listCashPurchases(tenantId: string, request: ListCashPurchasesRequest): Promise<Page<CashPurchaseView>> {
  const { supplierId, ...rest } = request;
  const page = await documents.list(CASH_PURCHASES, tenantId, {
    ...rest,
    ...(supplierId !== undefined ? { partyId: supplierId } : {}),
  });
  return { ...page, data: page.data.map(toView) };
}

// ---------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------

export interface CashPurchaseLineRequest {
  readonly itemId?: string;
  readonly accountId?: string;
  readonly description?: string;
  readonly quantity: number;
  readonly amountMinor?: number;
  readonly unitPriceMinor?: number;
  readonly taxRateBps: number;
  readonly taxAccountId?: string;
}

export interface CreateCashPurchaseRequest {
  readonly tenantId: string;
  readonly clientUuid: string;
  readonly branchId?: string;
  readonly supplierId?: string;
  readonly supplierReference?: string;
  readonly date?: string;
  readonly paymentMethod: SupplierPaymentMethod;
  /** Omit for the business's Cash, Bank or M-Pesa account (by method). */
  readonly paidFromAccountId?: string;
  /** With a supplier; omit for the business's PAYABLE account. */
  readonly payableAccountId?: string;
  readonly currency?: string;
  readonly taxMode: TaxMode;
  readonly reference?: string;
  readonly memo?: string;
  readonly lines: readonly CashPurchaseLineRequest[];
}

function journalLines(
  moneyAccountId: string,
  totalMinor: number,
  lines: readonly repository.LineInput[],
  through: { readonly payableAccountId: string; readonly supplierId: string } | null,
  narrative: string,
): CreateJournalLineRequest[] {
  const taxByAccount = new Map<string, number>();
  for (const line of lines) {
    if (line.taxAccountId && line.taxMinor > 0) {
      taxByAccount.set(line.taxAccountId, (taxByAccount.get(line.taxAccountId) ?? 0) + line.taxMinor);
    }
  }
  const payables: CreateJournalLineRequest[] = through
    ? [
        { accountId: through.payableAccountId, debitMinor: 0, creditMinor: totalMinor, narrative, supplierId: through.supplierId },
        { accountId: through.payableAccountId, debitMinor: totalMinor, creditMinor: 0, narrative, supplierId: through.supplierId },
      ]
    : [];
  return [
    ...lines
      .filter((line) => line.netMinor > 0)
      .map((line) => ({
        accountId: line.accountId,
        debitMinor: line.netMinor,
        creditMinor: 0,
        ...(line.description ? { narrative: line.description.slice(0, 500) } : {}),
      })),
    ...Array.from(taxByAccount, ([accountId, value]) => ({
      accountId,
      debitMinor: value,
      creditMinor: 0,
      narrative: "Input tax",
    })),
    ...payables,
    { accountId: moneyAccountId, debitMinor: 0, creditMinor: totalMinor, narrative },
  ];
}

export async function createCashPurchase(request: CreateCashPurchaseRequest, audit: AuditContext): Promise<CashPurchaseDetailView> {
  const tenant = await tenantsService.getTenant(request.tenantId);
  if (request.currency !== undefined && request.currency !== tenant.base_currency) {
    throw new DomainError(
      "CURRENCY_MISMATCH",
      `Cash purchases are in the base currency (${tenant.base_currency}) only for now; got ${request.currency}`,
    );
  }
  const currency = tenant.base_currency;
  const supplier = request.supplierId !== undefined ? await suppliersService.getSupplier(request.tenantId, request.supplierId) : null;
  if (supplier && supplier.currency !== null && supplier.currency !== currency) {
    throw new DomainError("CURRENCY_MISMATCH", `${supplier.name} trades in ${supplier.currency}; cash purchases are in ${currency} only for now`);
  }
  // A cheque leaves the bank.
  const paidFromAccountId =
    request.paidFromAccountId ??
    (await accountsService.defaultMoneyAccountId(
      request.tenantId,
      request.paymentMethod === "CHEQUE" ? "BANK" : request.paymentMethod,
      "paidFromAccountId",
      audit,
    ));
  const payableAccountId = supplier
    ? (request.payableAccountId ?? (await accountsService.requireSystemAccount(request.tenantId, "PAYABLE", "payableAccountId")).id)
    : null;

  const lines = await documents.resolveLines(
    CASH_PURCHASES,
    request.tenantId,
    request.lines.map((line) => ({
      ...(line.itemId !== undefined ? { itemId: line.itemId } : {}),
      ...(line.accountId !== undefined ? { accountId: line.accountId } : {}),
      ...(line.description !== undefined ? { description: line.description } : {}),
      quantity: line.quantity,
      ...(line.amountMinor !== undefined ? { amountMinor: line.amountMinor } : {}),
      ...(line.unitPriceMinor !== undefined ? { unitPriceMinor: line.unitPriceMinor } : {}),
      taxRateBps: line.taxRateBps,
      ...(line.taxAccountId !== undefined ? { taxAccountId: line.taxAccountId } : {}),
    })),
  );
  const built = await documents.buildLines(CASH_PURCHASES, request.tenantId, request.taxMode, lines, paidFromAccountId);
  if (built.totalMinor === 0) {
    throw new DomainError("INVOICE_INVALID_STATE", "A cash purchase must be for more than zero");
  }

  const date = request.date ?? todayInNairobi();
  const narrative = supplier ? `Cash purchase from ${supplier.name}` : "Cash purchase";
  // The purchase's id is chosen now so it can be its journal's clientUuid.
  const id = randomUUID();
  const prepared = await journalsService.prepareJournal(
    {
      tenantId: request.tenantId,
      clientUuid: id,
      ...(request.branchId !== undefined ? { branchId: request.branchId } : {}),
      date,
      currency: currency as CurrencyCode,
      description: narrative, // numbered inside the transaction
      source: "BILL",
      lines: journalLines(
        paidFromAccountId,
        built.totalMinor,
        built.lines,
        supplier && payableAccountId ? { payableAccountId, supplierId: supplier.id } : null,
        narrative,
      ),
    },
    audit,
  );

  await withTenant(request.tenantId, async (client) => {
    const number = formatInvoiceNumber("CASH_PURCHASE", await repository.nextSequence(client, request.tenantId, "CASH_PURCHASE"));
    let description = supplier ? `Cash purchase ${number} from ${supplier.name}` : `Cash purchase ${number}`;
    if (request.supplierReference) {
      description += ` (supplier ref ${request.supplierReference})`;
    }
    const journal = await journalsService.postPreparedJournal(
      client,
      { ...prepared, description, reference: request.reference ?? number },
      audit,
    );
    await repository.insertSettledDocument(
      client,
      {
        id,
        kind: "CASH_PURCHASE",
        tenantId: request.tenantId,
        clientUuid: request.clientUuid,
        ...(request.branchId !== undefined ? { branchId: request.branchId } : {}),
        ...(supplier ? { supplierId: supplier.id } : {}),
        ...(request.supplierReference !== undefined ? { supplierReference: request.supplierReference } : {}),
        issueDate: date,
        currency,
        paymentMethod: request.paymentMethod,
        moneyAccountId: paidFromAccountId,
        ...(payableAccountId ? { payableAccountId } : {}),
        taxMode: request.taxMode,
        subtotalMinor: built.subtotalMinor,
        taxMinor: built.taxMinor,
        totalMinor: built.totalMinor,
        ...(request.reference !== undefined ? { reference: request.reference } : {}),
        ...(request.memo !== undefined ? { memo: request.memo } : {}),
        number,
        journalId: journal.id,
        lines: built.lines,
      },
      audit,
    );
  });
  return getCashPurchase(request.tenantId, id);
}
