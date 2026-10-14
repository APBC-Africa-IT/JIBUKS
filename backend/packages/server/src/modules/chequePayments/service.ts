/**
 * Cheque payments service -- cheques as numbered documents (CHQ-000001),
 * the Write Cheque screen.
 *
 * A cheque is settled when it is written, so like a cash sale it has no
 * draft: one request validates it, then in ONE transaction takes the next
 * CHQ- number, posts the journal and stores the cheque already PAID:
 *   Dr line account(s) (net) -- expense, stock (an item's inventory
 *                               account) or any other account
 *   Dr input VAT (by VAT account)
 *     Cr the bank account (total)
 * The payee (an optional supplier) is recorded on the cheque only; nothing
 * is owed, so the supplier's balance and aging don't move. Paying a
 * supplier's bill is POST /supplier-bills/{id}/payments, not this.
 *
 * The older POST /cheques, which posts a journal with no document, is
 * unchanged.
 */

import { randomUUID } from "node:crypto";
import { DomainError, formatInvoiceNumber, type CurrencyCode, type TaxMode } from "@jibuks/domain";
import { withTenant, type AuditContext } from "@jibuks/db";
import * as accountsService from "../accounts/service.js";
import * as suppliersService from "../suppliers/service.js";
import * as documents from "../invoices/documents.js";
import { CHEQUES, type DocumentDetail, type DocumentView, type Page } from "../invoices/documents.js";
import * as repository from "../invoices/repository.js";
import type { InvoiceLineRow } from "../invoices/repository.js";
import type { CreateJournalLineRequest } from "../journals/service.js";
import * as journalsService from "../journals/service.js";
import { todayInNairobi } from "../periods/service.js";
import * as tenantsService from "../tenants/service.js";

// ---------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------

export interface ChequePaymentLineView {
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

export interface ChequePaymentView {
  readonly id: string;
  readonly client_uuid: string;
  readonly branch_id: string | null;
  /** CHQ-000001 -- the business's own gapless number. */
  readonly number: string;
  /** The number on the cheque leaf. */
  readonly cheque_number: string | null;
  readonly status: string;
  readonly supplier_id: string | null;
  readonly supplier_name: string | null;
  readonly date: string;
  readonly currency: string;
  readonly bank_account_id: string;
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

export interface ChequePaymentDetailView extends ChequePaymentView {
  readonly lines: ChequePaymentLineView[];
}

function toView(v: DocumentView): ChequePaymentView {
  return {
    id: v.id,
    client_uuid: v.client_uuid,
    branch_id: v.branch_id,
    number: v.number!,
    cheque_number: v.cheque_number,
    status: v.status,
    supplier_id: v.supplier_id,
    supplier_name: v.party_name,
    date: v.issue_date,
    currency: v.currency,
    bank_account_id: v.deposit_account_id!,
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

function toLineView(l: InvoiceLineRow): ChequePaymentLineView {
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

function toDetail(detail: DocumentDetail): ChequePaymentDetailView {
  const { lines, allocations, ...view } = detail;
  return { ...toView(view), lines: lines.map(toLineView) };
}

export async function getChequePayment(tenantId: string, id: string): Promise<ChequePaymentDetailView> {
  return toDetail(await documents.getDetail(CHEQUES, tenantId, id));
}

export interface ListChequePaymentsRequest {
  readonly supplierId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit: number;
  readonly cursor?: string;
}

export async function listChequePayments(
  tenantId: string,
  request: ListChequePaymentsRequest,
): Promise<Page<ChequePaymentView>> {
  const { supplierId, ...rest } = request;
  const page = await documents.list(CHEQUES, tenantId, {
    ...rest,
    ...(supplierId !== undefined ? { partyId: supplierId } : {}),
  });
  return { ...page, data: page.data.map(toView) };
}

// ---------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------

export interface ChequePaymentLineRequest {
  readonly itemId?: string;
  readonly accountId?: string;
  readonly description?: string;
  readonly quantity: number;
  readonly amountMinor?: number;
  readonly unitPriceMinor?: number;
  readonly taxRateBps: number;
  readonly taxAccountId?: string;
}

export interface CreateChequePaymentRequest {
  readonly tenantId: string;
  readonly clientUuid: string;
  readonly branchId?: string;
  /** Omit for the business's BANK account. */
  readonly bankAccountId?: string;
  readonly chequeNumber?: string;
  readonly supplierId?: string;
  readonly date?: string;
  readonly currency?: string;
  readonly taxMode: TaxMode;
  readonly reference?: string;
  readonly memo?: string;
  readonly lines: readonly ChequePaymentLineRequest[];
}

function journalLines(
  bankAccountId: string,
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
    { accountId: bankAccountId, debitMinor: 0, creditMinor: totalMinor },
  ];
}

export async function createChequePayment(
  request: CreateChequePaymentRequest,
  audit: AuditContext,
): Promise<ChequePaymentDetailView> {
  const tenant = await tenantsService.getTenant(request.tenantId);
  if (request.currency !== undefined && request.currency !== tenant.base_currency) {
    throw new DomainError(
      "CURRENCY_MISMATCH",
      `Cheques are in the base currency (${tenant.base_currency}) only for now; got ${request.currency}`,
    );
  }
  const currency = tenant.base_currency;
  if (request.supplierId !== undefined) {
    const supplier = await suppliersService.getSupplier(request.tenantId, request.supplierId);
    if (supplier.currency !== null && supplier.currency !== currency) {
      throw new DomainError(
        "CURRENCY_MISMATCH",
        `${supplier.name} trades in ${supplier.currency}; cheques are in ${currency} only for now`,
      );
    }
  }
  const bankAccountId =
    request.bankAccountId ?? (await accountsService.requireSystemAccount(request.tenantId, "BANK", "bankAccountId")).id;

  const lines = await documents.resolveLines(
    CHEQUES,
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
  const built = await documents.buildLines(CHEQUES, request.tenantId, request.taxMode, lines, bankAccountId);

  const date = request.date ?? todayInNairobi();
  // The cheque's id is chosen now so it can be its journal's clientUuid.
  const id = randomUUID();
  const prepared = await journalsService.prepareJournal(
    {
      tenantId: request.tenantId,
      clientUuid: id,
      ...(request.branchId !== undefined ? { branchId: request.branchId } : {}),
      date,
      currency: currency as CurrencyCode,
      description: "Cheque", // numbered inside the transaction
      source: "PAYMENT",
      lines: journalLines(bankAccountId, built.totalMinor, built.lines),
    },
    audit,
  );

  await withTenant(request.tenantId, async (client) => {
    const number = formatInvoiceNumber("CHEQUE", await repository.nextSequence(client, request.tenantId, "CHEQUE"));
    const description = request.chequeNumber ? `Cheque ${number} (cheque no. ${request.chequeNumber})` : `Cheque ${number}`;
    const journal = await journalsService.postPreparedJournal(
      client,
      { ...prepared, description, reference: request.chequeNumber ?? number },
      audit,
    );
    await repository.insertSettledDocument(
      client,
      {
        id,
        kind: "CHEQUE",
        tenantId: request.tenantId,
        clientUuid: request.clientUuid,
        ...(request.branchId !== undefined ? { branchId: request.branchId } : {}),
        ...(request.supplierId !== undefined ? { supplierId: request.supplierId } : {}),
        issueDate: date,
        currency,
        moneyAccountId: bankAccountId,
        ...(request.chequeNumber !== undefined ? { chequeNumber: request.chequeNumber } : {}),
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
  return getChequePayment(request.tenantId, id);
}
