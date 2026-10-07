/**
 * Invoices service -- sales invoices, credit notes and pro-formas
 * (FR-AR-02/05, FR-PAY-04, FR-TAX-01).
 *
 * What posts, and when:
 *   draft create/edit/delete  nothing
 *   issue INVOICE             Dr Receivable (gross, customer) / Cr income per line (net) / Cr tax per tax account
 *   issue CREDIT_NOTE         the mirror of the above, applied to its invoice's balance
 *   issue PROFORMA            nothing -- it only gets a PF- number
 *   payment                   Dr received account / Cr Receivable (customer), applied to the invoice
 *   cancel INVOICE            reversal of the issue journal; only before any payment
 *
 * Each posting is prepared (every ledger check run) BEFORE its transaction,
 * then the journal and the invoice change are written in ONE transaction,
 * with the invoice row locked -- so the ledger and the invoice can't drift
 * apart, and numbers are gapless.
 */

import { ZodError } from "zod";
import {
  DomainError,
  computeInvoiceTotals,
  formatInvoiceNumber,
  invoiceViewStatus,
  isUuid,
  type CurrencyCode,
  type InvoiceKind,
  type InvoicePaymentMethod,
  type InvoiceViewStatus,
  type TaxMode,
} from "@jibuks/domain";
import { withTenant, type AuditContext } from "@jibuks/db";
import * as accountsService from "../accounts/service.js";
import * as customersService from "../customers/service.js";
import * as journalsService from "../journals/service.js";
import type { CreateJournalLineRequest, PreparedJournal } from "../journals/service.js";
import { todayInNairobi } from "../periods/service.js";
import * as tenantsService from "../tenants/service.js";
import * as repository from "./repository.js";
import type { AllocationRow, InvoiceLineRow, InvoiceListRow, InvoiceRow, LineInput } from "./repository.js";

// ---------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------

/** What API clients see: the SRS status (OVERDUE derived) and the balance still owed. */
export interface InvoiceView extends Omit<InvoiceListRow, "status"> {
  readonly status: InvoiceViewStatus;
  readonly balance_due_minor: string;
}

export interface InvoiceDetailView extends InvoiceView {
  readonly lines: InvoiceLineRow[];
  readonly allocations: AllocationRow[];
}

function balanceDue(row: InvoiceRow): number {
  return row.kind === "INVOICE" && row.status !== "CANCELLED" && row.status !== "DRAFT"
    ? Number(row.total_minor) - Number(row.amount_paid_minor)
    : 0;
}

function toView(row: InvoiceListRow, today: string): InvoiceView {
  const { sort_key, ...rest } = row as InvoiceListRow & { sort_key?: string };
  return {
    ...rest,
    status: invoiceViewStatus(row.kind, row.status, row.due_date, today),
    balance_due_minor: String(balanceDue(row)),
  };
}

function notFound(invoiceId: string): DomainError {
  return new DomainError("INVOICE_NOT_FOUND", `Invoice ${invoiceId} not found`);
}

async function getRow(tenantId: string, invoiceId: string): Promise<InvoiceRow> {
  const row = isUuid(invoiceId) ? await repository.getInvoice(tenantId, invoiceId) : null;
  if (!row) {
    throw notFound(invoiceId);
  }
  return row;
}

export async function getInvoice(tenantId: string, invoiceId: string): Promise<InvoiceDetailView> {
  const detail = isUuid(invoiceId) ? await repository.getInvoiceDetail(tenantId, invoiceId) : null;
  if (!detail) {
    throw notFound(invoiceId);
  }
  const { lines, allocations, ...row } = detail;
  return { ...toView(row, todayInNairobi()), lines, allocations };
}

// ---------------------------------------------------------------------
// Listing -- cursor pagination (Section 9.1)
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

export interface InvoicePage {
  readonly data: InvoiceView[];
  readonly next_cursor: string | null;
  readonly has_more: boolean;
}

function encodeCursor(row: repository.InvoicePageRow): string {
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

export async function listInvoices(tenantId: string, request: ListInvoicesRequest): Promise<InvoicePage> {
  const today = todayInNairobi();
  const rows = await repository.listInvoices(tenantId, {
    ...(request.status !== undefined ? { status: request.status } : {}),
    ...(request.kind !== undefined ? { kind: request.kind } : {}),
    ...(request.customerId !== undefined ? { customerId: request.customerId } : {}),
    ...(request.from !== undefined ? { from: request.from } : {}),
    ...(request.to !== undefined ? { to: request.to } : {}),
    ...(request.cursor !== undefined ? { after: decodeCursor(request.cursor) } : {}),
    today,
    limit: request.limit,
  });
  const hasMore = rows.length > request.limit;
  const page = rows.slice(0, request.limit);
  return {
    data: page.map((row) => toView(row, today)),
    next_cursor: hasMore ? encodeCursor(page.at(-1)!) : null,
    has_more: hasMore,
  };
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

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function assertPostableAccount(tenantId: string, accountId: string): Promise<void> {
  const account = await accountsService.getAccount(tenantId, accountId);
  if (!account.is_active) {
    throw new DomainError("ACCOUNT_INACTIVE", `Account ${accountId} is inactive`);
  }
  if (!account.is_postable) {
    throw new DomainError("ACCOUNT_NOT_POSTABLE", `Account ${accountId} is a header account and can't be posted to`);
  }
}

/**
 * Validates a draft's lines and accounts and computes its amounts. Invoices
 * are in the tenant's base currency only (multi-currency is Phase 2).
 */
async function buildLines(
  tenantId: string,
  taxMode: TaxMode,
  lines: readonly InvoiceLineRequest[],
  receivableAccountId: string | null,
): Promise<{ lines: LineInput[]; subtotalMinor: number; taxMinor: number; totalMinor: number }> {
  if (taxMode !== "NONE" && lines.some((l) => l.taxRateBps > 0)) {
    const tenant = await tenantsService.getTenant(tenantId);
    if (!tenant.vat_registered) {
      throw new DomainError(
        "TAX_NOT_REGISTERED",
        "This business isn't registered for VAT, so its invoices can't charge tax",
      );
    }
  }
  for (const line of lines) {
    if (taxMode === "NONE" && line.taxRateBps > 0) {
      throw new DomainError("INVOICE_INVALID_STATE", "taxMode NONE allows no tax rate on any line");
    }
  }

  const accountIds = new Set<string>(
    lines.flatMap((l) => [l.incomeAccountId, ...(l.taxRateBps > 0 && l.taxAccountId ? [l.taxAccountId] : [])]),
  );
  if (receivableAccountId !== null) {
    accountIds.add(receivableAccountId);
  }
  await Promise.all(Array.from(accountIds, (id) => assertPostableAccount(tenantId, id)));

  const totals = computeInvoiceTotals(lines, taxMode);
  if (totals.totalMinor <= 0) {
    throw new DomainError("JOURNAL_LINE_EMPTY", "An invoice's total must be greater than zero");
  }
  return {
    lines: lines.map((line, i) => ({
      description: line.description,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      incomeAccountId: line.incomeAccountId,
      taxRateBps: taxMode === "NONE" ? 0 : line.taxRateBps,
      ...(line.taxRateBps > 0 && taxMode !== "NONE" && line.taxAccountId ? { taxAccountId: line.taxAccountId } : {}),
      netMinor: totals.lines[i]!.netMinor,
      taxMinor: totals.lines[i]!.taxMinor,
      totalMinor: totals.lines[i]!.totalMinor,
    })),
    subtotalMinor: totals.subtotalMinor,
    taxMinor: totals.taxMinor,
    totalMinor: totals.totalMinor,
  };
}

/** The customer, checked to trade in the tenant's base currency. */
async function loadCustomer(tenantId: string, customerId: string, currency: string) {
  const customer = await customersService.getCustomer(tenantId, customerId);
  if (customer.currency !== null && customer.currency !== currency) {
    throw new DomainError(
      "CURRENCY_MISMATCH",
      `Customer ${customerId} trades in ${customer.currency}; invoices are in ${currency} only for now`,
    );
  }
  return customer;
}

async function baseCurrency(tenantId: string, requested?: string): Promise<string> {
  const tenant = await tenantsService.getTenant(tenantId);
  if (requested !== undefined && requested !== tenant.base_currency) {
    throw new DomainError(
      "CURRENCY_MISMATCH",
      `Invoices are in the base currency (${tenant.base_currency}) only for now; got ${requested}`,
    );
  }
  return tenant.base_currency;
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
  const currency = await baseCurrency(request.tenantId, request.currency);
  const customer = await loadCustomer(request.tenantId, request.customerId, currency);
  const built = await buildLines(request.tenantId, request.taxMode, request.lines, request.receivableAccountId ?? null);
  const dueDate =
    request.dueDate ??
    (request.kind === "INVOICE" ? addDays(request.issueDate, customer.payment_terms_days ?? 0) : null);

  const invoice = await repository.insertInvoice(
    {
      tenantId: request.tenantId,
      clientUuid: request.clientUuid,
      ...(request.branchId !== undefined ? { branchId: request.branchId } : {}),
      kind: request.kind,
      customerId: request.customerId,
      issueDate: request.issueDate,
      dueDate,
      currency,
      ...(request.receivableAccountId !== undefined ? { receivableAccountId: request.receivableAccountId } : {}),
      taxMode: request.taxMode,
      ...built,
      ...(request.reference !== undefined ? { reference: request.reference } : {}),
      ...(request.notes !== undefined ? { notes: request.notes } : {}),
      ...(request.proformaId !== undefined ? { proformaId: request.proformaId } : {}),
    },
    audit,
  );
  return getInvoice(request.tenantId, invoice.id);
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

function linesFromRows(rows: readonly InvoiceLineRow[]): InvoiceLineRequest[] {
  return rows.map((row) => ({
    description: row.description,
    quantity: Number(row.quantity),
    unitPriceMinor: Number(row.unit_price_minor),
    incomeAccountId: row.income_account_id,
    taxRateBps: row.tax_rate_bps,
    ...(row.tax_account_id ? { taxAccountId: row.tax_account_id } : {}),
  }));
}

function assertDraft(row: InvoiceRow, action: string): void {
  if (row.status !== "DRAFT") {
    throw new DomainError(
      "INVOICE_INVALID_STATE",
      `Only a draft can be ${action}; ${row.number ?? row.id} is ${row.status.toLowerCase()}`,
    );
  }
}

export async function updateInvoice(
  tenantId: string,
  invoiceId: string,
  patch: UpdateInvoiceRequest,
  audit: AuditContext,
): Promise<InvoiceDetailView> {
  const current = await getRow(tenantId, invoiceId);
  assertDraft(current, "edited");
  if (current.kind === "CREDIT_NOTE" && (patch.customerId !== undefined || patch.receivableAccountId !== undefined)) {
    throw new DomainError(
      "INVOICE_INVALID_STATE",
      "A credit note's customer and receivable account come from its invoice and can't be changed",
    );
  }

  const customerId = patch.customerId ?? current.customer_id;
  const customer = await loadCustomer(tenantId, customerId, current.currency);
  const issueDate = patch.issueDate ?? current.issue_date;
  const taxMode = patch.taxMode ?? current.tax_mode;
  const receivableAccountId = patch.receivableAccountId ?? current.receivable_account_id;
  const lines = patch.lines ?? linesFromRows(await repository.getLines(tenantId, invoiceId));
  const built = await buildLines(tenantId, taxMode, lines, receivableAccountId);

  let dueDate: string | null;
  if (current.kind === "CREDIT_NOTE") {
    dueDate = null;
  } else if (patch.dueDate !== undefined && patch.dueDate !== null) {
    dueDate = patch.dueDate;
  } else if (patch.dueDate === null || patch.issueDate !== undefined || patch.customerId !== undefined) {
    // Recompute from terms when asked to, or when what it depends on changed.
    dueDate = current.kind === "INVOICE" ? addDays(issueDate, customer.payment_terms_days ?? 0) : null;
  } else {
    dueDate = current.due_date;
  }
  if (dueDate !== null && dueDate < issueDate) {
    throw new DomainError("INVOICE_INVALID_STATE", "dueDate can't be before issueDate");
  }

  const updated = await repository.updateDraft(
    tenantId,
    invoiceId,
    {
      customerId,
      receivableAccountId,
      issueDate,
      dueDate,
      taxMode,
      ...built,
      reference: patch.reference !== undefined ? patch.reference : current.reference,
      notes: patch.notes !== undefined ? patch.notes : current.notes,
    },
    audit,
  );
  if (!updated) {
    assertDraft(await getRow(tenantId, invoiceId), "edited"); // issued meanwhile
  }
  return getInvoice(tenantId, invoiceId);
}

export async function deleteInvoice(tenantId: string, invoiceId: string, audit: AuditContext): Promise<void> {
  const current = await getRow(tenantId, invoiceId);
  assertDraft(current, "deleted");
  if (!(await repository.deleteDraft(tenantId, invoiceId, audit))) {
    assertDraft(await getRow(tenantId, invoiceId), "deleted");
  }
}

// ---------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------

const DOC_NAMES: Readonly<Record<InvoiceKind, string>> = {
  INVOICE: "Invoice",
  CREDIT_NOTE: "Credit note",
  PROFORMA: "Pro-forma",
};

/**
 * The issue journal for an INVOICE, or its mirror for a CREDIT_NOTE. Lines
 * with nothing to post (a zero-priced line, a zero-rated tax) are left out.
 */
function issueJournalLines(invoice: InvoiceRow, lines: readonly InvoiceLineRow[]): CreateJournalLineRequest[] {
  const creditNote = invoice.kind === "CREDIT_NOTE";
  const side = (amount: number, natural: "debit" | "credit") => {
    const debit = (natural === "debit") !== creditNote;
    return { debitMinor: debit ? amount : 0, creditMinor: debit ? 0 : amount };
  };

  const taxByAccount = new Map<string, number>();
  for (const line of lines) {
    if (line.tax_account_id && Number(line.tax_minor) > 0) {
      taxByAccount.set(line.tax_account_id, (taxByAccount.get(line.tax_account_id) ?? 0) + Number(line.tax_minor));
    }
  }

  return [
    {
      accountId: invoice.receivable_account_id!,
      ...side(Number(invoice.total_minor), "debit"),
      customerId: invoice.customer_id,
    },
    ...lines
      .filter((line) => Number(line.net_minor) > 0)
      .map((line) => ({
        accountId: line.income_account_id,
        ...side(Number(line.net_minor), "credit"),
        narrative: line.description.slice(0, 500),
      })),
    ...Array.from(taxByAccount, ([accountId, amount]) => ({
      accountId,
      ...side(amount, "credit"),
      narrative: "Sales tax",
    })),
  ];
}

export interface IssueInvoiceRequest {
  readonly overrideCreditLimit: boolean;
  /** Whether the caller holds invoices:override_credit_limit. */
  readonly mayOverrideCreditLimit: boolean;
}

/** FR-AR-01 credit limit: the customer's balance after this invoice must stay within it. */
async function checkCreditLimit(invoice: InvoiceRow, request: IssueInvoiceRequest): Promise<boolean> {
  const customer = await customersService.getCustomer(invoice.tenant_id, invoice.customer_id);
  if (customer.credit_limit_minor === null) {
    return false;
  }
  const limit = Number(customer.credit_limit_minor);
  const after = Number(customer.balance_minor) + Number(invoice.total_minor);
  if (after <= limit) {
    return false;
  }
  if (!request.overrideCreditLimit) {
    throw new DomainError(
      "CREDIT_LIMIT_EXCEEDED",
      `This invoice takes ${customer.name} to ${after} against a credit limit of ${limit} (minor units). ` +
        "Someone allowed to override credit limits can issue it with overrideCreditLimit: true.",
    );
  }
  if (!request.mayOverrideCreditLimit) {
    throw new DomainError("FORBIDDEN", 'Overriding a credit limit requires the "invoices:override_credit_limit" permission');
  }
  return true;
}

function assertCreditable(original: InvoiceRow): void {
  if (original.kind !== "INVOICE" || (original.status !== "ISSUED" && original.status !== "PART_PAID")) {
    throw new DomainError(
      "INVOICE_INVALID_STATE",
      `A credit note needs an issued, unpaid or part-paid invoice; ${original.number ?? original.id} is ${original.status.toLowerCase()}`,
    );
  }
}

function assertCreditFits(original: InvoiceRow, creditMinor: number): void {
  const due = balanceDue(original);
  if (creditMinor > due) {
    throw new DomainError(
      "CREDIT_NOTE_EXCEEDS_BALANCE",
      `The credit note (${creditMinor}) is more than the ${due} still owed on ${original.number} (minor units)`,
    );
  }
}

export async function issueInvoice(
  tenantId: string,
  invoiceId: string,
  request: IssueInvoiceRequest,
  audit: AuditContext,
): Promise<InvoiceDetailView> {
  const invoice = await getRow(tenantId, invoiceId);
  assertDraft(invoice, "issued");

  let creditLimitOverridden = false;
  let prepared: PreparedJournal | null = null;
  if (invoice.kind !== "PROFORMA") {
    if (invoice.kind === "INVOICE") {
      creditLimitOverridden = await checkCreditLimit(invoice, request);
    } else {
      const original = await getRow(tenantId, invoice.credited_invoice_id!);
      assertCreditable(original);
      assertCreditFits(original, Number(invoice.total_minor));
    }
    const lines = await repository.getLines(tenantId, invoiceId);
    prepared = await journalsService.prepareJournal(
      {
        tenantId,
        // The invoice's own id: one issue journal per invoice, enforced by the database.
        clientUuid: invoice.id,
        ...(invoice.branch_id ? { branchId: invoice.branch_id } : {}),
        date: invoice.issue_date,
        currency: invoice.currency as CurrencyCode,
        description: DOC_NAMES[invoice.kind], // numbered inside the transaction
        source: "SALE",
        lines: issueJournalLines(invoice, lines),
      },
      audit,
    );
  }

  await withTenant(tenantId, async (client) => {
    const locked = await repository.lockInvoice(client, invoiceId);
    if (!locked || locked.status !== "DRAFT" || locked.updated_at.valueOf() !== invoice.updated_at.valueOf()) {
      throw new DomainError("INVOICE_INVALID_STATE", "The invoice changed while it was being issued; try again");
    }
    const original = locked.credited_invoice_id ? await repository.lockInvoice(client, locked.credited_invoice_id) : null;
    if (original) {
      assertCreditable(original);
      assertCreditFits(original, Number(locked.total_minor));
    }

    const number = formatInvoiceNumber(locked.kind, await repository.nextSequence(client, tenantId, locked.kind));
    const description = original
      ? `Credit note ${number} against ${original.number}`
      : `${DOC_NAMES[locked.kind]} ${number}`;
    const journal = prepared
      ? await journalsService.postPreparedJournal(client, { ...prepared, description, reference: number }, audit)
      : null;
    const issued = await repository.markIssued(
      client,
      locked,
      { number, journalId: journal?.id ?? null, creditLimitOverridden },
      audit,
    );
    if (original && journal) {
      await repository.applyAllocation(
        client,
        original,
        {
          clientUuid: issued.id,
          method: "CREDIT_NOTE",
          amountMinor: Number(issued.total_minor),
          unappliedMinor: 0,
          date: issued.issue_date,
          reference: number,
          journalId: journal.id,
          creditNoteId: issued.id,
        },
        audit,
      );
    }
  });
  return getInvoice(tenantId, invoiceId);
}

// ---------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------

export async function cancelInvoice(
  tenantId: string,
  invoiceId: string,
  reason: string,
  audit: AuditContext,
): Promise<InvoiceDetailView> {
  const invoice = await getRow(tenantId, invoiceId);
  if (invoice.status === "DRAFT") {
    throw new DomainError("INVOICE_INVALID_STATE", "A draft isn't cancelled -- delete it instead");
  }
  if (invoice.status === "CANCELLED") {
    throw new DomainError("INVOICE_INVALID_STATE", `${invoice.number} is already cancelled`);
  }
  if (invoice.kind === "CREDIT_NOTE") {
    throw new DomainError("INVOICE_INVALID_STATE", "An issued credit note can't be cancelled");
  }
  const assertUnpaid = (row: InvoiceRow) => {
    if (Number(row.amount_paid_minor) > 0) {
      throw new DomainError(
        "INVOICE_HAS_PAYMENTS",
        `${row.number} has payments or credit notes applied; raise a credit note for the rest instead of cancelling`,
      );
    }
  };
  assertUnpaid(invoice);

  const prepared = invoice.journal_id
    ? await journalsService.prepareReversal(tenantId, invoice.journal_id, `Cancelled ${invoice.number}: ${reason}`, audit)
    : null;

  await withTenant(tenantId, async (client) => {
    const locked = await repository.lockInvoice(client, invoiceId);
    if (!locked || (locked.status !== "ISSUED" && locked.status !== "PART_PAID")) {
      throw new DomainError("INVOICE_INVALID_STATE", "The invoice changed while it was being cancelled; try again");
    }
    assertUnpaid(locked);
    const journal = prepared ? await journalsService.postPreparedJournal(client, prepared, audit) : null;
    await repository.markCancelled(client, locked, journal?.id ?? null, reason, audit);
  });
  return getInvoice(tenantId, invoiceId);
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
  /**
   * false (manual payments): more than the balance is refused (422).
   * true (M-Pesa): the money has already arrived, so all of it is posted to
   * the customer's receivable and anything beyond the balance is recorded
   * as unapplied -- customer credit -- rather than refused.
   */
  readonly allowOverpayment: boolean;
}

export interface ApplyPaymentResult {
  readonly journalId: string;
  readonly allocation: AllocationRow;
}

function assertPayable(row: InvoiceRow, amountMinor: number): void {
  if (row.kind !== "INVOICE") {
    throw new DomainError("INVOICE_INVALID_STATE", `Payments are taken against invoices, not a ${DOC_NAMES[row.kind].toLowerCase()}`);
  }
  if (row.status !== "ISSUED" && row.status !== "PART_PAID") {
    throw new DomainError(
      "INVOICE_INVALID_STATE",
      `${row.number ?? "This draft"} is ${row.status.toLowerCase()}; payments are taken against issued invoices`,
    );
  }
  const due = balanceDue(row);
  if (amountMinor > due) {
    throw new DomainError(
      "INVOICE_OVERPAYMENT",
      `${amountMinor} is more than the ${due} still owed on ${row.number} (minor units)`,
    );
  }
}

export async function applyPayment(request: ApplyPaymentRequest, audit: AuditContext): Promise<ApplyPaymentResult> {
  const invoice = await getRow(request.tenantId, request.invoiceId);
  if (!request.allowOverpayment) {
    assertPayable(invoice, request.amountMinor);
  } else if (invoice.kind !== "INVOICE" || invoice.status === "DRAFT") {
    throw new DomainError("INVOICE_INVALID_STATE", "Payments are taken against issued invoices");
  }

  const description = `Payment for ${invoice.number}`;
  const prepared = await journalsService.prepareJournal(
    {
      tenantId: request.tenantId,
      clientUuid: request.clientUuid,
      ...(invoice.branch_id ? { branchId: invoice.branch_id } : {}),
      date: request.date,
      currency: invoice.currency as CurrencyCode,
      description,
      ...(request.reference !== undefined ? { reference: request.reference } : {}),
      source: "PAYMENT",
      lines: [
        { accountId: request.receivedAccountId, debitMinor: request.amountMinor, creditMinor: 0, narrative: description },
        {
          accountId: invoice.receivable_account_id!,
          debitMinor: 0,
          creditMinor: request.amountMinor,
          narrative: description,
          customerId: invoice.customer_id,
        },
      ],
    },
    audit,
  );

  return withTenant(request.tenantId, async (client) => {
    const locked = (await repository.lockInvoice(client, request.invoiceId))!;
    let applied = request.amountMinor;
    if (!request.allowOverpayment) {
      assertPayable(locked, request.amountMinor); // re-checked under the lock
    } else {
      applied = Math.min(request.amountMinor, balanceDue(locked));
    }
    const journal = await journalsService.postPreparedJournal(client, prepared, audit);
    const { allocation } = await repository.applyAllocation(
      client,
      locked,
      {
        clientUuid: request.clientUuid,
        method: request.method,
        amountMinor: applied,
        unappliedMinor: request.amountMinor - applied,
        date: request.date,
        receivedAccountId: request.receivedAccountId,
        ...(request.reference !== undefined ? { reference: request.reference } : {}),
        journalId: journal.id,
        ...(request.paymentId !== undefined ? { paymentId: request.paymentId } : {}),
      },
      audit,
    );
    return { journalId: journal.id, allocation };
  });
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
  const invoice = await getRow(tenantId, invoiceId);
  assertPayable(invoice, amountMinor);
  return {
    id: invoice.id,
    number: invoice.number!,
    customerId: invoice.customer_id,
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
  const original = await getRow(request.tenantId, request.invoiceId);
  assertCreditable(original);
  const taxMode = request.taxMode ?? original.tax_mode;
  const built = await buildLines(request.tenantId, taxMode, request.lines, original.receivable_account_id);
  assertCreditFits(original, built.totalMinor + (await repository.sumDraftCreditNotes(request.tenantId, original.id)));

  const creditNote = await repository.insertInvoice(
    {
      tenantId: request.tenantId,
      clientUuid: request.clientUuid,
      ...(original.branch_id ? { branchId: original.branch_id } : {}),
      kind: "CREDIT_NOTE",
      customerId: original.customer_id,
      issueDate: request.issueDate ?? todayInNairobi(),
      dueDate: null,
      currency: original.currency,
      receivableAccountId: original.receivable_account_id!,
      taxMode,
      ...built,
      ...(request.reference !== undefined ? { reference: request.reference } : {}),
      ...(request.notes !== undefined ? { notes: request.notes } : {}),
      creditedInvoiceId: original.id,
    },
    audit,
  );
  return getInvoice(request.tenantId, creditNote.id);
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
  const proforma = await getRow(request.tenantId, request.proformaId);
  if (proforma.kind !== "PROFORMA" || proforma.status === "CANCELLED") {
    throw new DomainError("INVOICE_INVALID_STATE", "Only a draft or issued pro-forma can be converted to an invoice");
  }
  const receivableAccountId = request.receivableAccountId ?? proforma.receivable_account_id;
  if (receivableAccountId === null) {
    throw new DomainError("INVOICE_INVALID_STATE", "The pro-forma has no receivable account; pass receivableAccountId");
  }
  const lines = linesFromRows(await repository.getLines(request.tenantId, proforma.id));
  return createInvoice(
    {
      tenantId: request.tenantId,
      clientUuid: request.clientUuid,
      kind: "INVOICE",
      ...(proforma.branch_id ? { branchId: proforma.branch_id } : {}),
      customerId: proforma.customer_id,
      receivableAccountId,
      issueDate: request.issueDate ?? todayInNairobi(),
      currency: proforma.currency,
      taxMode: proforma.tax_mode,
      ...(proforma.reference ? { reference: proforma.reference } : {}),
      ...(proforma.notes ? { notes: proforma.notes } : {}),
      lines,
      proformaId: proforma.id,
    },
    audit,
  );
}

