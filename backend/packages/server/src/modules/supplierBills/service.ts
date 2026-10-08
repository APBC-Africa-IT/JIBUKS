/**
 * Supplier bills service -- bills and debit notes (FR-AP-02).
 *
 * The public face of the supplier side (AP) of the document engine in
 * ../invoices/documents.ts, which holds the posting rules (and the tables,
 * shared with sales invoices). This file gives bills their own names:
 * supplier_id, payable_account_id, bill_date, expense_account_id,
 * paid_from_account_id, debited_bill_id, posted_at.
 */

import type { InvoiceKind, InvoicePaymentMethod, InvoiceViewStatus, TaxMode } from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import * as documents from "../invoices/documents.js";
import { AP, type DocumentDetail, type DocumentView, type LineRequest, type Page } from "../invoices/documents.js";
import type { AllocationRow, InvoiceLineRow } from "../invoices/repository.js";

// ---------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------

export interface BillView {
  readonly id: string;
  readonly client_uuid: string;
  readonly branch_id: string | null;
  readonly kind: "BILL" | "DEBIT_NOTE";
  readonly status: InvoiceViewStatus;
  readonly number: string | null;
  readonly supplier_id: string;
  readonly supplier_name: string;
  readonly supplier_reference: string | null;
  readonly bill_date: string;
  readonly due_date: string | null;
  readonly currency: string;
  readonly payable_account_id: string | null;
  readonly tax_mode: TaxMode;
  readonly subtotal_minor: string;
  readonly tax_minor: string;
  readonly total_minor: string;
  readonly amount_paid_minor: string;
  readonly balance_due_minor: string;
  readonly reference: string | null;
  readonly notes: string | null;
  readonly journal_id: string | null;
  readonly cancel_journal_id: string | null;
  readonly debited_bill_id: string | null;
  readonly cancel_reason: string | null;
  readonly created_by: string;
  readonly posted_by: string | null;
  readonly cancelled_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly posted_at: string | null;
  readonly cancelled_at: string | null;
}

export interface BillLineView {
  readonly id: string;
  readonly line_no: number;
  readonly description: string;
  readonly quantity: string;
  readonly unit_price_minor: string;
  readonly expense_account_id: string;
  readonly tax_rate_bps: number;
  readonly tax_account_id: string | null;
  readonly net_minor: string;
  readonly tax_minor: string;
  readonly total_minor: string;
}

export interface BillPaymentView {
  readonly id: string;
  readonly client_uuid: string;
  readonly method: string;
  readonly amount_minor: string;
  readonly date: string;
  readonly paid_from_account_id: string | null;
  readonly reference: string | null;
  readonly journal_id: string;
  readonly debit_note_id: string | null;
  readonly created_by: string;
  readonly created_at: string;
}

export interface BillDetailView extends BillView {
  readonly lines: BillLineView[];
  readonly allocations: BillPaymentView[];
}

function toBillView(v: DocumentView): BillView {
  return {
    id: v.id,
    client_uuid: v.client_uuid,
    branch_id: v.branch_id,
    kind: v.kind as "BILL" | "DEBIT_NOTE",
    status: v.status,
    number: v.number,
    supplier_id: v.supplier_id!,
    supplier_name: v.party_name,
    supplier_reference: v.supplier_reference,
    bill_date: v.issue_date,
    due_date: v.due_date,
    currency: v.currency,
    payable_account_id: v.receivable_account_id,
    tax_mode: v.tax_mode,
    subtotal_minor: v.subtotal_minor,
    tax_minor: v.tax_minor,
    total_minor: v.total_minor,
    amount_paid_minor: v.amount_paid_minor,
    balance_due_minor: v.balance_due_minor,
    reference: v.reference,
    notes: v.notes,
    journal_id: v.journal_id,
    cancel_journal_id: v.cancel_journal_id,
    debited_bill_id: v.credited_invoice_id,
    cancel_reason: v.cancel_reason,
    created_by: v.created_by,
    posted_by: v.issued_by,
    cancelled_by: v.cancelled_by,
    created_at: v.created_at,
    updated_at: v.updated_at,
    posted_at: v.issued_at,
    cancelled_at: v.cancelled_at,
  };
}

function toLineView(l: InvoiceLineRow): BillLineView {
  return {
    id: l.id,
    line_no: l.line_no,
    description: l.description,
    quantity: l.quantity,
    unit_price_minor: l.unit_price_minor,
    expense_account_id: l.income_account_id,
    tax_rate_bps: l.tax_rate_bps,
    tax_account_id: l.tax_account_id,
    net_minor: l.net_minor,
    tax_minor: l.tax_minor,
    total_minor: l.total_minor,
  };
}

function toPaymentView(a: AllocationRow): BillPaymentView {
  return {
    id: a.id,
    client_uuid: a.client_uuid,
    method: a.method,
    amount_minor: a.amount_minor,
    date: a.date,
    paid_from_account_id: a.received_account_id,
    reference: a.reference,
    journal_id: a.journal_id,
    debit_note_id: a.credit_note_id,
    created_by: a.created_by,
    created_at: a.created_at,
  };
}

function toBillDetail(detail: DocumentDetail): BillDetailView {
  const { lines, allocations, ...view } = detail;
  return { ...toBillView(view), lines: lines.map(toLineView), allocations: allocations.map(toPaymentView) };
}

export async function getBill(tenantId: string, billId: string): Promise<BillDetailView> {
  return toBillDetail(await documents.getDetail(AP, tenantId, billId));
}

// ---------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------

export interface ListBillsRequest {
  readonly status?: InvoiceViewStatus;
  readonly kind?: InvoiceKind;
  readonly supplierId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit: number;
  readonly cursor?: string;
}

export async function listBills(tenantId: string, request: ListBillsRequest): Promise<Page<BillView>> {
  const { supplierId, ...rest } = request;
  const page = await documents.list(AP, tenantId, { ...rest, ...(supplierId !== undefined ? { partyId: supplierId } : {}) });
  return { ...page, data: page.data.map(toBillView) };
}

// ---------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------

export interface BillLineRequest {
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly expenseAccountId: string;
  readonly taxRateBps: number;
  readonly taxAccountId?: string;
}

function toLineRequests(lines: readonly BillLineRequest[]): LineRequest[] {
  return lines.map(({ expenseAccountId, ...line }) => ({ ...line, accountId: expenseAccountId }));
}

export interface CreateBillRequest {
  readonly tenantId: string;
  readonly clientUuid: string;
  readonly branchId?: string;
  readonly supplierId: string;
  /** Omit for the business's PAYABLE account. */
  readonly payableAccountId?: string;
  readonly billDate: string;
  readonly dueDate?: string;
  readonly supplierReference?: string;
  readonly currency?: string;
  readonly taxMode: TaxMode;
  readonly reference?: string;
  readonly notes?: string;
  readonly lines: readonly BillLineRequest[];
}

export async function createBill(request: CreateBillRequest, audit: AuditContext): Promise<BillDetailView> {
  const { supplierId, payableAccountId, billDate, lines, ...rest } = request;
  return toBillDetail(
    await documents.create(
      AP,
      {
        ...rest,
        kind: "BILL",
        partyId: supplierId,
        ...(payableAccountId !== undefined ? { controlAccountId: payableAccountId } : {}),
        issueDate: billDate,
        lines: toLineRequests(lines),
      },
      audit,
    ),
  );
}

export interface UpdateBillRequest {
  readonly supplierId?: string;
  readonly payableAccountId?: string;
  readonly billDate?: string;
  readonly dueDate?: string | null;
  readonly supplierReference?: string | null;
  readonly taxMode?: TaxMode;
  readonly reference?: string | null;
  readonly notes?: string | null;
  readonly lines?: readonly BillLineRequest[];
}

export async function updateBill(
  tenantId: string,
  billId: string,
  patch: UpdateBillRequest,
  audit: AuditContext,
): Promise<BillDetailView> {
  const { supplierId, payableAccountId, billDate, lines, ...rest } = patch;
  return toBillDetail(
    await documents.update(
      AP,
      tenantId,
      billId,
      {
        ...rest,
        ...(supplierId !== undefined ? { partyId: supplierId } : {}),
        ...(payableAccountId !== undefined ? { controlAccountId: payableAccountId } : {}),
        ...(billDate !== undefined ? { issueDate: billDate } : {}),
        ...(lines !== undefined ? { lines: toLineRequests(lines) } : {}),
      },
      audit,
    ),
  );
}

export async function deleteBill(tenantId: string, billId: string, audit: AuditContext): Promise<void> {
  await documents.remove(AP, tenantId, billId, audit);
}

// ---------------------------------------------------------------------
// Post, cancel, pay, debit notes
// ---------------------------------------------------------------------

export async function postBill(tenantId: string, billId: string, audit: AuditContext): Promise<BillDetailView> {
  return toBillDetail(
    await documents.issue(AP, tenantId, billId, { overrideCreditLimit: false, mayOverrideCreditLimit: false }, audit),
  );
}

export async function cancelBill(tenantId: string, billId: string, reason: string, audit: AuditContext): Promise<BillDetailView> {
  return toBillDetail(await documents.cancel(AP, tenantId, billId, reason, audit));
}

export interface PayBillRequest {
  readonly tenantId: string;
  readonly billId: string;
  readonly clientUuid: string;
  readonly amountMinor: number;
  readonly date: string;
  readonly paidFromAccountId: string;
  readonly method: InvoicePaymentMethod;
  readonly reference?: string;
}

export async function payBill(request: PayBillRequest, audit: AuditContext): Promise<BillDetailView> {
  const { billId, paidFromAccountId, ...rest } = request;
  await documents.pay(AP, { ...rest, id: billId, moneyAccountId: paidFromAccountId, allowOverpayment: false }, audit);
  return getBill(request.tenantId, billId);
}

export interface CreateDebitNoteRequest {
  readonly tenantId: string;
  readonly billId: string;
  readonly clientUuid: string;
  readonly noteDate?: string;
  readonly taxMode?: TaxMode;
  readonly reference?: string;
  readonly notes?: string;
  readonly lines: readonly BillLineRequest[];
}

/** A DRAFT debit note against a posted bill; posting it applies it. */
export async function createDebitNote(request: CreateDebitNoteRequest, audit: AuditContext): Promise<BillDetailView> {
  const { billId, noteDate, lines, ...rest } = request;
  return toBillDetail(
    await documents.createReduction(
      AP,
      { ...rest, originalId: billId, ...(noteDate !== undefined ? { issueDate: noteDate } : {}), lines: toLineRequests(lines) },
      audit,
    ),
  );
}
