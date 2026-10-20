/**
 * Sales receipts service -- cash sales as numbered documents (CS-000001).
 *
 * A cash sale is paid on the spot, so unlike an invoice it has no draft:
 * one request validates it, then in ONE transaction takes the next CS-
 * number, posts the journal and stores the sale already PAID:
 *   Dr deposit account (total)
 *     Cr income line(s) (net)
 *     Cr output VAT (by VAT account)
 * Nothing is owed, so no line is tagged with the customer -- the customer
 * (optional; none = walk-in) is recorded on the sale only and never
 * touches their balance or aging.
 *
 * The rows live in the invoices tables (kind CASH_SALE) and reuse the
 * document engine's line maths (computeInvoiceTotals) and checks, but are
 * never visible through /invoices. The older POST /cash-sales, which posts
 * a journal with no document, is unchanged.
 */

import { randomUUID } from "node:crypto";
import {
  DomainError,
  formatInvoiceNumber,
  type CurrencyCode,
  type InvoicePaymentMethod,
  type TaxMode,
} from "@jibuks/domain";
import { withTenant, type AuditContext } from "@jibuks/db";
import * as accountsService from "../accounts/service.js";
import * as customersService from "../customers/service.js";
import * as documents from "../invoices/documents.js";
import { CASH_SALES, type DocumentDetail, type DocumentView, type Page } from "../invoices/documents.js";
import * as repository from "../invoices/repository.js";
import type { InvoiceLineRow } from "../invoices/repository.js";
import type { CreateJournalLineRequest } from "../journals/service.js";
import * as journalsService from "../journals/service.js";
import { todayInNairobi } from "../periods/service.js";
import * as tenantsService from "../tenants/service.js";

// ---------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------

export interface SalesReceiptLineView {
  readonly id: string;
  readonly line_no: number;
  readonly item_id: string | null;
  readonly item: string;
  readonly description: string | null;
  readonly quantity: string;
  readonly unit_price_minor: string;
  readonly income_account_id: string;
  readonly tax_rate_bps: number;
  readonly tax_account_id: string | null;
  readonly net_minor: string;
  readonly tax_minor: string;
  readonly total_minor: string;
}

export interface SalesReceiptView {
  readonly id: string;
  readonly client_uuid: string;
  readonly branch_id: string | null;
  readonly number: string;
  /** PAID -- a cash sale is paid when it is recorded. */
  readonly status: string;
  /** Null for a walk-in customer. */
  readonly customer_id: string | null;
  readonly customer_name: string | null;
  readonly date: string;
  readonly currency: string;
  readonly payment_method: InvoicePaymentMethod;
  readonly deposit_account_id: string;
  readonly tax_mode: TaxMode;
  readonly subtotal_minor: string;
  readonly tax_minor: string;
  readonly total_minor: string;
  readonly reference: string | null;
  readonly message_to_customer: string | null;
  readonly memo: string | null;
  readonly journal_id: string;
  readonly created_by: string;
  /** When it was recorded -- the time printed on the receipt. */
  readonly created_at: string;
}

export interface SalesReceiptDetailView extends SalesReceiptView {
  readonly lines: SalesReceiptLineView[];
}

function toView(v: DocumentView): SalesReceiptView {
  return {
    id: v.id,
    client_uuid: v.client_uuid,
    branch_id: v.branch_id,
    number: v.number!,
    status: v.status,
    customer_id: v.customer_id,
    customer_name: v.party_name,
    date: v.issue_date,
    currency: v.currency,
    payment_method: v.payment_method!,
    deposit_account_id: v.deposit_account_id!,
    tax_mode: v.tax_mode,
    subtotal_minor: v.subtotal_minor,
    tax_minor: v.tax_minor,
    total_minor: v.total_minor,
    reference: v.reference,
    message_to_customer: v.notes,
    memo: v.memo,
    journal_id: v.journal_id!,
    created_by: v.created_by,
    created_at: v.created_at,
  };
}

function toLineView(l: InvoiceLineRow): SalesReceiptLineView {
  return {
    id: l.id,
    line_no: l.line_no,
    item_id: l.item_id,
    item: l.item_name ?? l.description,
    description: l.item_name !== null && l.description !== "" ? l.description : null,
    quantity: l.quantity,
    unit_price_minor: l.unit_price_minor,
    income_account_id: l.income_account_id,
    tax_rate_bps: l.tax_rate_bps,
    tax_account_id: l.tax_account_id,
    net_minor: l.net_minor,
    tax_minor: l.tax_minor,
    total_minor: l.total_minor,
  };
}

function toDetail(detail: DocumentDetail): SalesReceiptDetailView {
  const { lines, allocations, ...view } = detail;
  return { ...toView(view), lines: lines.map(toLineView) };
}

export async function getSalesReceipt(tenantId: string, id: string): Promise<SalesReceiptDetailView> {
  return toDetail(await documents.getDetail(CASH_SALES, tenantId, id));
}

// ---------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------

export interface ListSalesReceiptsRequest {
  readonly customerId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit: number;
  readonly cursor?: string;
}

export async function listSalesReceipts(tenantId: string, request: ListSalesReceiptsRequest): Promise<Page<SalesReceiptView>> {
  const { customerId, ...rest } = request;
  const page = await documents.list(CASH_SALES, tenantId, {
    ...rest,
    ...(customerId !== undefined ? { partyId: customerId } : {}),
  });
  return { ...page, data: page.data.map(toView) };
}

// ---------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------

/** With itemId, item, unitPriceMinor and incomeAccountId default from the item. */
export interface SalesReceiptLineRequest {
  readonly itemId?: string;
  readonly item?: string;
  readonly description?: string;
  readonly quantity: number;
  readonly unitPriceMinor?: number;
  readonly incomeAccountId?: string;
  readonly taxRateBps: number;
  readonly taxAccountId?: string;
}

export interface CreateSalesReceiptRequest {
  readonly tenantId: string;
  readonly clientUuid: string;
  readonly branchId?: string;
  readonly customerId?: string;
  /** Omit for today (Africa/Nairobi). */
  readonly date?: string;
  readonly paymentMethod: InvoicePaymentMethod;
  /** Omit for the business's CASH, BANK or M-Pesa account, by paymentMethod. */
  readonly depositAccountId?: string;
  readonly currency?: string;
  readonly taxMode: TaxMode;
  readonly reference?: string;
  readonly messageToCustomer?: string;
  readonly memo?: string;
  readonly lines: readonly SalesReceiptLineRequest[];
}


function journalLines(
  depositAccountId: string,
  totalMinor: number,
  lines: readonly repository.LineInput[],
): CreateJournalLineRequest[] {
  const taxByAccount = new Map<string, number>();
  for (const line of lines) {
    if (line.taxAccountId && line.taxMinor > 0) {
      taxByAccount.set(line.taxAccountId, (taxByAccount.get(line.taxAccountId) ?? 0) + line.taxMinor);
    }
  }
  return [
    { accountId: depositAccountId, debitMinor: totalMinor, creditMinor: 0 },
    ...lines
      .filter((line) => line.netMinor > 0)
      .map((line) => ({
        accountId: line.accountId,
        debitMinor: 0,
        creditMinor: line.netMinor,
        narrative: (line.description ? `${line.itemName} - ${line.description}` : line.itemName!).slice(0, 500),
      })),
    ...Array.from(taxByAccount, ([accountId, value]) => ({
      accountId,
      debitMinor: 0,
      creditMinor: value,
      narrative: "Sales tax",
    })),
  ];
}

export async function createSalesReceipt(
  request: CreateSalesReceiptRequest,
  audit: AuditContext,
): Promise<SalesReceiptDetailView> {
  const tenant = await tenantsService.getTenant(request.tenantId);
  if (request.currency !== undefined && request.currency !== tenant.base_currency) {
    throw new DomainError(
      "CURRENCY_MISMATCH",
      `Cash sales are in the base currency (${tenant.base_currency}) only for now; got ${request.currency}`,
    );
  }
  const currency = tenant.base_currency;
  if (request.customerId !== undefined) {
    const customer = await customersService.getCustomer(request.tenantId, request.customerId);
    if (customer.currency !== null && customer.currency !== currency) {
      throw new DomainError(
        "CURRENCY_MISMATCH",
        `${customer.name} trades in ${customer.currency}; cash sales are in ${currency} only for now`,
      );
    }
  }
  const depositAccountId =
    request.depositAccountId ??
    (await accountsService.defaultMoneyAccountId(request.tenantId, request.paymentMethod, "depositAccountId", audit));
  const lines = await documents.resolveLines(
    CASH_SALES,
    request.tenantId,
    request.lines.map((line) => ({
      ...(line.itemId !== undefined ? { itemId: line.itemId } : {}),
      ...(line.item !== undefined ? { itemName: line.item } : {}),
      ...(line.description !== undefined ? { description: line.description } : {}),
      quantity: line.quantity,
      ...(line.unitPriceMinor !== undefined ? { unitPriceMinor: line.unitPriceMinor } : {}),
      ...(line.incomeAccountId !== undefined ? { accountId: line.incomeAccountId } : {}),
      taxRateBps: line.taxRateBps,
      ...(line.taxAccountId !== undefined ? { taxAccountId: line.taxAccountId } : {}),
    })),
  );
  const built = await documents.buildLines(CASH_SALES, request.tenantId, request.taxMode, lines, depositAccountId);

  const date = request.date ?? todayInNairobi();
  // The sale's id is chosen now so it can be its journal's clientUuid:
  // one journal per sale, enforced by the database.
  const id = randomUUID();
  const prepared = await journalsService.prepareJournal(
    {
      tenantId: request.tenantId,
      clientUuid: id,
      ...(request.branchId !== undefined ? { branchId: request.branchId } : {}),
      date,
      currency: currency as CurrencyCode,
      description: "Cash sale", // numbered inside the transaction
      source: "CASHBOOK",
      lines: journalLines(depositAccountId, built.totalMinor, built.lines),
    },
    audit,
  );

  await withTenant(request.tenantId, async (client) => {
    const number = formatInvoiceNumber("CASH_SALE", await repository.nextSequence(client, request.tenantId, "CASH_SALE"));
    const journal = await journalsService.postPreparedJournal(
      client,
      { ...prepared, description: `Cash sale ${number}`, reference: number },
      audit,
    );
    await repository.insertSettledDocument(
      client,
      {
        id,
        kind: "CASH_SALE",
        tenantId: request.tenantId,
        clientUuid: request.clientUuid,
        ...(request.branchId !== undefined ? { branchId: request.branchId } : {}),
        ...(request.customerId !== undefined ? { customerId: request.customerId } : {}),
        issueDate: date,
        currency,
        paymentMethod: request.paymentMethod,
        moneyAccountId: depositAccountId,
        taxMode: request.taxMode,
        subtotalMinor: built.subtotalMinor,
        taxMinor: built.taxMinor,
        totalMinor: built.totalMinor,
        ...(request.reference !== undefined ? { reference: request.reference } : {}),
        ...(request.messageToCustomer !== undefined ? { notes: request.messageToCustomer } : {}),
        ...(request.memo !== undefined ? { memo: request.memo } : {}),
        number,
        journalId: journal.id,
        lines: built.lines,
      },
      audit,
    );
  });
  return getSalesReceipt(request.tenantId, id);
}
