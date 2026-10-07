/**
 * Invoices service -- sales invoices, credit notes and pro-formas
 * (FR-AR-02/05, FR-PAY-04, FR-TAX-01).
 *
 * The public face of the sales side (AR) of the document engine in
 * documents.ts, which holds the posting rules. This file keeps the
 * invoice field names (customer_id, receivable_account_id,
 * incomeAccountId, ...) and adds what only sales have: pro-forma
 * conversion, the PDF and collection by M-Pesa.
 */

import { DomainError, type InvoiceKind, type InvoicePaymentMethod, type InvoiceViewStatus, type TaxMode } from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import * as customersService from "../customers/service.js";
import { todayInNairobi } from "../periods/service.js";
import * as tenantsService from "../tenants/service.js";
import * as documents from "./documents.js";
import { AR, type DocumentDetail, type DocumentView, type LineRequest, type Page } from "./documents.js";
import { buildInvoicePdfModel, renderInvoicePdf } from "./pdf.js";
import * as repository from "./repository.js";
import type { AllocationRow, InvoiceLineRow } from "./repository.js";

// ---------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------

/** What API clients see for a sales document. */
export interface InvoiceView
  extends Omit<DocumentView, "party_name" | "supplier_id" | "supplier_reference" | "customer_id"> {
  readonly customer_id: string;
  readonly customer_name: string;
}

export interface InvoiceDetailView extends InvoiceView {
  readonly lines: InvoiceLineRow[];
  readonly allocations: AllocationRow[];
}

function toInvoiceView(view: DocumentView): InvoiceView {
  const { party_name, supplier_id, supplier_reference, customer_id, ...rest } = view;
  return { ...rest, customer_id: customer_id!, customer_name: party_name };
}

function toInvoiceDetail(detail: DocumentDetail): InvoiceDetailView {
  const { lines, allocations, ...view } = detail;
  return { ...toInvoiceView(view), lines, allocations };
}

export async function getInvoice(tenantId: string, invoiceId: string): Promise<InvoiceDetailView> {
  return toInvoiceDetail(await documents.getDetail(AR, tenantId, invoiceId));
}

// ---------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------

export interface ListInvoicesRequest {
  readonly status?: InvoiceViewStatus;
  readonly kind?: InvoiceKind;
  readonly customerId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit: number;
  readonly cursor?: string;
}

export async function listInvoices(tenantId: string, request: ListInvoicesRequest): Promise<Page<InvoiceView>> {
  const { customerId, ...rest } = request;
  const page = await documents.list(AR, tenantId, { ...rest, ...(customerId !== undefined ? { partyId: customerId } : {}) });
  return { ...page, data: page.data.map(toInvoiceView) };
}

// ---------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------

export interface InvoiceLineRequest {
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly incomeAccountId: string;
  readonly taxRateBps: number;
  readonly taxAccountId?: string;
}

function toLineRequests(lines: readonly InvoiceLineRequest[]): LineRequest[] {
  return lines.map(({ incomeAccountId, ...line }) => ({ ...line, accountId: incomeAccountId }));
}

export interface CreateInvoiceRequest {
  readonly tenantId: string;
  readonly clientUuid: string;
  readonly kind: "INVOICE" | "PROFORMA";
  readonly branchId?: string;
  readonly customerId: string;
  readonly receivableAccountId?: string;
  readonly issueDate: string;
  readonly dueDate?: string;
  readonly currency?: string;
  readonly taxMode: TaxMode;
  readonly reference?: string;
  readonly notes?: string;
  readonly lines: readonly InvoiceLineRequest[];
  /** Set by convertProforma. */
  readonly proformaId?: string;
}

export async function createInvoice(request: CreateInvoiceRequest, audit: AuditContext): Promise<InvoiceDetailView> {
  const { customerId, receivableAccountId, lines, ...rest } = request;
  return toInvoiceDetail(
    await documents.create(
      AR,
      {
        ...rest,
        partyId: customerId,
        ...(receivableAccountId !== undefined ? { controlAccountId: receivableAccountId } : {}),
        lines: toLineRequests(lines),
      },
      audit,
    ),
  );
}

export interface UpdateInvoiceRequest {
  readonly customerId?: string;
  readonly receivableAccountId?: string;
  readonly issueDate?: string;
  readonly dueDate?: string | null;
  readonly taxMode?: TaxMode;
  readonly reference?: string | null;
  readonly notes?: string | null;
  readonly lines?: readonly InvoiceLineRequest[];
}

export async function updateInvoice(
  tenantId: string,
  invoiceId: string,
  patch: UpdateInvoiceRequest,
  audit: AuditContext,
): Promise<InvoiceDetailView> {
  const { customerId, receivableAccountId, lines, ...rest } = patch;
  return toInvoiceDetail(
    await documents.update(
      AR,
      tenantId,
      invoiceId,
      {
        ...rest,
        ...(customerId !== undefined ? { partyId: customerId } : {}),
        ...(receivableAccountId !== undefined ? { controlAccountId: receivableAccountId } : {}),
        ...(lines !== undefined ? { lines: toLineRequests(lines) } : {}),
      },
      audit,
    ),
  );
}

export async function deleteInvoice(tenantId: string, invoiceId: string, audit: AuditContext): Promise<void> {
  await documents.remove(AR, tenantId, invoiceId, audit);
}

// ---------------------------------------------------------------------
// Issue and cancel
// ---------------------------------------------------------------------

export type IssueInvoiceRequest = documents.IssueRequest;

export async function issueInvoice(
  tenantId: string,
  invoiceId: string,
  request: IssueInvoiceRequest,
  audit: AuditContext,
): Promise<InvoiceDetailView> {
  return toInvoiceDetail(await documents.issue(AR, tenantId, invoiceId, request, audit));
}

export async function cancelInvoice(
  tenantId: string,
  invoiceId: string,
  reason: string,
  audit: AuditContext,
): Promise<InvoiceDetailView> {
  return toInvoiceDetail(await documents.cancel(AR, tenantId, invoiceId, reason, audit));
}

// ---------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------

export interface ApplyPaymentRequest {
  readonly tenantId: string;
  readonly invoiceId: string;
  /** Identity of the allocation and of its journal. */
  readonly clientUuid: string;
  readonly amountMinor: number;
  readonly date: string;
  readonly receivedAccountId: string;
  readonly method: InvoicePaymentMethod;
  readonly reference?: string;
  /** Set for an M-Pesa collection (payments module). */
  readonly paymentId?: string;
  /** See documents.PaymentRequest. M-Pesa collections pass true. */
  readonly allowOverpayment: boolean;
}

export type ApplyPaymentResult = documents.PaymentResult;

export async function applyPayment(request: ApplyPaymentRequest, audit: AuditContext): Promise<ApplyPaymentResult> {
  const { invoiceId, receivedAccountId, ...rest } = request;
  return documents.pay(AR, { ...rest, id: invoiceId, moneyAccountId: receivedAccountId }, audit);
}

export async function recordPayment(
  request: Omit<ApplyPaymentRequest, "allowOverpayment" | "paymentId">,
  audit: AuditContext,
): Promise<InvoiceDetailView> {
  await applyPayment({ ...request, allowOverpayment: false }, audit);
  return getInvoice(request.tenantId, request.invoiceId);
}

export interface CollectableInvoice {
  readonly id: string;
  readonly number: string;
  readonly customerId: string;
  readonly receivableAccountId: string;
  readonly currency: string;
}

/** Checks an M-Pesa collection may be started against this invoice (payments module). */
export async function assertCollectable(
  tenantId: string,
  invoiceId: string,
  amountMinor: number,
): Promise<CollectableInvoice> {
  const invoice = await documents.assertPayableNow(AR, tenantId, invoiceId, amountMinor);
  return {
    id: invoice.id,
    number: invoice.number!,
    customerId: invoice.customer_id!,
    receivableAccountId: invoice.receivable_account_id!,
    currency: invoice.currency,
  };
}

// ---------------------------------------------------------------------
// Credit notes and pro-forma conversion
// ---------------------------------------------------------------------

export interface CreateCreditNoteRequest {
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly clientUuid: string;
  readonly issueDate?: string;
  readonly taxMode?: TaxMode;
  readonly reference?: string;
  readonly notes?: string;
  readonly lines: readonly InvoiceLineRequest[];
}

/** A DRAFT credit note against an issued invoice; issuing it applies it. */
export async function createCreditNote(request: CreateCreditNoteRequest, audit: AuditContext): Promise<InvoiceDetailView> {
  const { invoiceId, lines, ...rest } = request;
  return toInvoiceDetail(
    await documents.createReduction(AR, { ...rest, originalId: invoiceId, lines: toLineRequests(lines) }, audit),
  );
}

export interface ConvertProformaRequest {
  readonly tenantId: string;
  readonly proformaId: string;
  readonly clientUuid: string;
  readonly issueDate?: string;
  readonly receivableAccountId?: string;
}

/** Copies a pro-forma into a new DRAFT invoice (once per pro-forma). */
export async function convertProforma(request: ConvertProformaRequest, audit: AuditContext): Promise<InvoiceDetailView> {
  const proforma = await documents.getRow(AR, request.tenantId, request.proformaId);
  if (proforma.kind !== "PROFORMA" || proforma.status === "CANCELLED") {
    throw new DomainError("INVOICE_INVALID_STATE", "Only a draft or issued pro-forma can be converted to an invoice");
  }
  const receivableAccountId = request.receivableAccountId ?? proforma.receivable_account_id;
  if (receivableAccountId === null) {
    throw new DomainError("INVOICE_INVALID_STATE", "The pro-forma has no receivable account; pass receivableAccountId");
  }
  const lines = documents.linesFromRows(await repository.getLines(request.tenantId, proforma.id));
  return toInvoiceDetail(
    await documents.create(
      AR,
      {
        tenantId: request.tenantId,
        clientUuid: request.clientUuid,
        kind: "INVOICE",
        ...(proforma.branch_id ? { branchId: proforma.branch_id } : {}),
        partyId: proforma.customer_id!,
        controlAccountId: receivableAccountId,
        issueDate: request.issueDate ?? todayInNairobi(),
        currency: proforma.currency,
        taxMode: proforma.tax_mode,
        ...(proforma.reference ? { reference: proforma.reference } : {}),
        ...(proforma.notes ? { notes: proforma.notes } : {}),
        lines,
        proformaId: proforma.id,
      },
      audit,
    ),
  );
}

// ---------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------

/** The invoice as a PDF, built on request (nothing is stored). */
export async function getInvoicePdf(tenantId: string, invoiceId: string): Promise<{ filename: string; pdf: Buffer }> {
  const invoice = await getInvoice(tenantId, invoiceId);
  const [tenant, customer, credited] = await Promise.all([
    tenantsService.getTenant(tenantId),
    customersService.getCustomer(tenantId, invoice.customer_id),
    invoice.credited_invoice_id ? repository.getInvoice(tenantId, invoice.credited_invoice_id) : null,
  ]);
  const model = buildInvoicePdfModel({
    invoice,
    business: { name: tenant.name, taxIdentifier: tenant.tax_identifier },
    customer: {
      name: customer.name,
      taxIdentifier: customer.tax_identifier,
      phone: customer.phone,
      email: customer.email,
      address: customer.address,
    },
    creditedInvoiceNumber: credited?.number ?? null,
  });
  return { filename: model.filename, pdf: await renderInvoicePdf(model) };
}
