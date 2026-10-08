/**
 * The document engine shared by sales invoices (side AR) and supplier
 * bills (side AP). service.ts (invoices) and bills.ts (supplier bills) are
 * thin public faces over it with their own field names.
 *
 * What posts, and when (AR / AP):
 *   draft create/edit/delete   nothing
 *   issue INVOICE / BILL       Dr Receivable / Cr income + output VAT  |  Dr expense + input VAT / Cr Payable
 *   issue CREDIT_NOTE / DEBIT_NOTE   the mirror of its document, applied to that document's balance
 *   issue PROFORMA (AR only)   nothing -- it only gets a PF- number
 *   payment                    Dr money / Cr Receivable  |  Dr Payable / Cr money
 *   cancel                     reversal of the issue journal; only before any payment
 * The control-account line is always tagged with the customer (AR) or
 * supplier (AP), so party balances and aging stay in step.
 *
 * Each posting is prepared (every ledger check run) BEFORE its transaction,
 * then the journal and the document change are written in ONE transaction
 * with the document row locked -- so the ledger and the document can't
 * drift apart, and numbers are gapless.
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
  type JournalSource,
  type TaxMode,
} from "@jibuks/domain";
import { withTenant, type AuditContext } from "@jibuks/db";
import * as accountsService from "../accounts/service.js";
import * as customersService from "../customers/service.js";
import * as suppliersService from "../suppliers/service.js";
import * as journalsService from "../journals/service.js";
import type { CreateJournalLineRequest, PreparedJournal } from "../journals/service.js";
import { todayInNairobi } from "../periods/service.js";
import * as tenantsService from "../tenants/service.js";
import * as repository from "./repository.js";
import type { AllocationRow, InvoiceLineRow, InvoiceListRow, InvoicePageRow, InvoiceRow, LineInput } from "./repository.js";

// ---------------------------------------------------------------------
// Sides
// ---------------------------------------------------------------------

export interface Side {
  readonly direction: "AR" | "AP";
  /** The document that is owed: INVOICE or BILL. */
  readonly main: "INVOICE" | "BILL";
  /** The document that reduces it: CREDIT_NOTE or DEBIT_NOTE. */
  readonly reduction: "CREDIT_NOTE" | "DEBIT_NOTE";
  readonly journalSource: JournalSource;
  /** "invoice" / "bill" -- used in messages. */
  readonly noun: string;
  readonly taxNarrative: string;
}

export const AR: Side = {
  direction: "AR",
  main: "INVOICE",
  reduction: "CREDIT_NOTE",
  journalSource: "SALE",
  noun: "invoice",
  taxNarrative: "Sales tax",
};

export const AP: Side = {
  direction: "AP",
  main: "BILL",
  reduction: "DEBIT_NOTE",
  journalSource: "BILL",
  noun: "bill",
  taxNarrative: "Input tax",
};

export const DOC_NAMES: Readonly<Record<InvoiceKind, string>> = {
  INVOICE: "Invoice",
  CREDIT_NOTE: "Credit note",
  PROFORMA: "Pro-forma",
  BILL: "Bill",
  DEBIT_NOTE: "Debit note",
};

function partyIdOf(side: Side, row: InvoiceRow): string {
  return (side.direction === "AR" ? row.customer_id : row.supplier_id)!;
}

function partyTag(side: Side, partyId: string): { customerId: string } | { supplierId: string } {
  return side.direction === "AR" ? { customerId: partyId } : { supplierId: partyId };
}

interface Party {
  readonly id: string;
  readonly name: string;
  readonly currency: string | null;
  readonly payment_terms_days: number | null;
  readonly balance_minor: string;
  readonly credit_limit_minor?: string | null;
}

async function loadParty(side: Side, tenantId: string, partyId: string): Promise<Party> {
  return side.direction === "AR"
    ? customersService.getCustomer(tenantId, partyId)
    : suppliersService.getSupplier(tenantId, partyId);
}

// ---------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------

/** A row as the engine hands it to a public face: SRS status and balance still owed. */
export interface DocumentView extends Omit<InvoiceListRow, "status"> {
  readonly status: InvoiceViewStatus;
  readonly balance_due_minor: string;
}

export interface DocumentDetail extends DocumentView {
  readonly lines: InvoiceLineRow[];
  readonly allocations: AllocationRow[];
}

export function balanceDue(row: InvoiceRow): number {
  return (row.kind === "INVOICE" || row.kind === "BILL") && row.status !== "CANCELLED" && row.status !== "DRAFT"
    ? Number(row.total_minor) - Number(row.amount_paid_minor)
    : 0;
}

function toView(row: InvoiceListRow, today: string): DocumentView {
  const { sort_key, ...rest } = row as InvoiceListRow & { sort_key?: string };
  return {
    ...rest,
    status: invoiceViewStatus(row.kind, row.status, row.due_date, today),
    balance_due_minor: String(balanceDue(row)),
  };
}

function notFound(side: Side, id: string): DomainError {
  return new DomainError("INVOICE_NOT_FOUND", `${side.noun === "bill" ? "Bill" : "Invoice"} ${id} not found`);
}

/** The row, if it exists AND belongs to this side -- a bill is never found through /invoices. */
export async function getRow(side: Side, tenantId: string, id: string): Promise<InvoiceRow> {
  const row = isUuid(id) ? await repository.getInvoice(tenantId, id) : null;
  if (!row || row.direction !== side.direction) {
    throw notFound(side, id);
  }
  return row;
}

export async function getDetail(side: Side, tenantId: string, id: string): Promise<DocumentDetail> {
  const detail = isUuid(id) ? await repository.getInvoiceDetail(tenantId, id) : null;
  if (!detail || detail.direction !== side.direction) {
    throw notFound(side, id);
  }
  const { lines, allocations, ...row } = detail;
  return { ...toView(row, todayInNairobi()), lines, allocations };
}

// ---------------------------------------------------------------------
// Listing -- cursor pagination (Section 9.1)
// ---------------------------------------------------------------------

export interface ListRequest {
  readonly status?: InvoiceViewStatus;
  readonly kind?: InvoiceKind;
  readonly partyId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit: number;
  readonly cursor?: string;
}

export interface Page<T> {
  readonly data: T[];
  readonly next_cursor: string | null;
  readonly has_more: boolean;
}

function encodeCursor(row: InvoicePageRow): string {
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

export async function list(side: Side, tenantId: string, request: ListRequest): Promise<Page<DocumentView>> {
  const today = todayInNairobi();
  const rows = await repository.listInvoices(tenantId, {
    direction: side.direction,
    ...(request.status !== undefined ? { status: request.status } : {}),
    ...(request.kind !== undefined ? { kind: request.kind } : {}),
    ...(request.partyId !== undefined ? { partyId: request.partyId } : {}),
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

export interface LineRequest {
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  /** Income (AR) or expense/asset (AP) account. */
  readonly accountId: string;
  readonly taxRateBps: number;
  readonly taxAccountId?: string;
}

export function addDays(date: string, days: number): string {
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
 * Validates a draft's lines and accounts and computes its amounts. Documents
 * are in the tenant's base currency only (multi-currency is Phase 2).
 */
async function buildLines(
  side: Side,
  tenantId: string,
  taxMode: TaxMode,
  lines: readonly LineRequest[],
  controlAccountId: string | null,
): Promise<{ lines: LineInput[]; subtotalMinor: number; taxMinor: number; totalMinor: number }> {
  if (taxMode !== "NONE" && lines.some((l) => l.taxRateBps > 0)) {
    const tenant = await tenantsService.getTenant(tenantId);
    if (!tenant.vat_registered) {
      throw new DomainError(
        "TAX_NOT_REGISTERED",
        side.direction === "AR"
          ? "This business isn't registered for VAT, so its invoices can't charge tax"
          : "This business isn't registered for VAT, so it can't claim input VAT; enter the bill with taxMode NONE",
      );
    }
  }
  if (taxMode === "NONE" && lines.some((l) => l.taxRateBps > 0)) {
    throw new DomainError("INVOICE_INVALID_STATE", "taxMode NONE allows no tax rate on any line");
  }

  // A taxed line without its own VAT account posts to the business's.
  if (taxMode !== "NONE" && lines.some((l) => l.taxRateBps > 0 && l.taxAccountId === undefined)) {
    const vatAccount = await accountsService.requireSystemAccount(
      tenantId,
      side.direction === "AR" ? "VAT_OUTPUT" : "VAT_INPUT",
      `lines[${lines.findIndex((l) => l.taxRateBps > 0 && l.taxAccountId === undefined)}].taxAccountId`,
    );
    lines = lines.map((l) => (l.taxRateBps > 0 && l.taxAccountId === undefined ? { ...l, taxAccountId: vatAccount.id } : l));
  }

  const accountIds = new Set<string>(
    lines.flatMap((l) => [l.accountId, ...(l.taxRateBps > 0 && l.taxAccountId ? [l.taxAccountId] : [])]),
  );
  if (controlAccountId !== null) {
    accountIds.add(controlAccountId);
  }
  await Promise.all(Array.from(accountIds, (id) => assertPostableAccount(tenantId, id)));

  const totals = computeInvoiceTotals(lines, taxMode);
  if (totals.totalMinor <= 0) {
    throw new DomainError("JOURNAL_LINE_EMPTY", `A ${side.noun}'s total must be greater than zero`);
  }
  return {
    lines: lines.map((line, i) => ({
      description: line.description,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      accountId: line.accountId,
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

/** The customer or supplier, checked to trade in the document's currency. */
async function loadTradingParty(side: Side, tenantId: string, partyId: string, currency: string): Promise<Party> {
  const party = await loadParty(side, tenantId, partyId);
  if (party.currency !== null && party.currency !== currency) {
    throw new DomainError(
      "CURRENCY_MISMATCH",
      `${party.name} trades in ${party.currency}; ${side.noun}s are in ${currency} only for now`,
    );
  }
  return party;
}

async function baseCurrency(side: Side, tenantId: string, requested?: string): Promise<string> {
  const tenant = await tenantsService.getTenant(tenantId);
  if (requested !== undefined && requested !== tenant.base_currency) {
    throw new DomainError(
      "CURRENCY_MISMATCH",
      `${DOC_NAMES[side.main]}s are in the base currency (${tenant.base_currency}) only for now; got ${requested}`,
    );
  }
  return tenant.base_currency;
}

export interface CreateRequest {
  readonly tenantId: string;
  readonly clientUuid: string;
  readonly kind: "INVOICE" | "PROFORMA" | "BILL";
  readonly branchId?: string;
  readonly partyId: string;
  readonly controlAccountId?: string;
  readonly issueDate: string;
  readonly dueDate?: string;
  readonly currency?: string;
  readonly taxMode: TaxMode;
  readonly supplierReference?: string;
  readonly reference?: string;
  readonly notes?: string;
  readonly lines: readonly LineRequest[];
  readonly proformaId?: string;
}

/**
 * The business's Accounts Receivable (AR) or Payable (AP), for a document
 * that names none. 422 SYSTEM_ACCOUNT_MISSING if it isn't marked.
 */
export async function defaultControlAccountId(side: Side, tenantId: string): Promise<string> {
  const account =
    side.direction === "AR"
      ? await accountsService.requireSystemAccount(tenantId, "RECEIVABLE", "receivableAccountId")
      : await accountsService.requireSystemAccount(tenantId, "PAYABLE", "payableAccountId");
  return account.id;
}

export async function create(side: Side, request: CreateRequest, audit: AuditContext): Promise<DocumentDetail> {
  const currency = await baseCurrency(side, request.tenantId, request.currency);
  const party = await loadTradingParty(side, request.tenantId, request.partyId, currency);
  // A pro-forma posts nothing, so it only gets a control account if asked.
  if (request.controlAccountId === undefined && request.kind === side.main) {
    request = { ...request, controlAccountId: await defaultControlAccountId(side, request.tenantId) };
  }
  const built = await buildLines(side, request.tenantId, request.taxMode, request.lines, request.controlAccountId ?? null);
  const dueDate =
    request.dueDate ??
    (request.kind === side.main ? addDays(request.issueDate, party.payment_terms_days ?? 0) : null);

  const row = await repository.insertInvoice(
    {
      tenantId: request.tenantId,
      clientUuid: request.clientUuid,
      ...(request.branchId !== undefined ? { branchId: request.branchId } : {}),
      direction: side.direction,
      kind: request.kind,
      ...(side.direction === "AR" ? { customerId: request.partyId } : { supplierId: request.partyId }),
      ...(request.supplierReference !== undefined ? { supplierReference: request.supplierReference } : {}),
      issueDate: request.issueDate,
      dueDate,
      currency,
      ...(request.controlAccountId !== undefined ? { controlAccountId: request.controlAccountId } : {}),
      taxMode: request.taxMode,
      ...built,
      ...(request.reference !== undefined ? { reference: request.reference } : {}),
      ...(request.notes !== undefined ? { notes: request.notes } : {}),
      ...(request.proformaId !== undefined ? { proformaId: request.proformaId } : {}),
    },
    audit,
  );
  return getDetail(side, request.tenantId, row.id);
}

export interface UpdateRequest {
  readonly partyId?: string;
  readonly controlAccountId?: string;
  readonly issueDate?: string;
  readonly dueDate?: string | null;
  readonly taxMode?: TaxMode;
  readonly supplierReference?: string | null;
  readonly reference?: string | null;
  readonly notes?: string | null;
  readonly lines?: readonly LineRequest[];
}

export function linesFromRows(rows: readonly InvoiceLineRow[]): LineRequest[] {
  return rows.map((row) => ({
    description: row.description,
    quantity: Number(row.quantity),
    unitPriceMinor: Number(row.unit_price_minor),
    accountId: row.income_account_id,
    taxRateBps: row.tax_rate_bps,
    ...(row.tax_account_id ? { taxAccountId: row.tax_account_id } : {}),
  }));
}

function assertDraft(side: Side, row: InvoiceRow, action: string): void {
  if (row.status !== "DRAFT") {
    throw new DomainError(
      "INVOICE_INVALID_STATE",
      `Only a draft can be ${action}; ${row.number ?? row.id} is ${row.status.toLowerCase()}`,
    );
  }
}

export async function update(
  side: Side,
  tenantId: string,
  id: string,
  patch: UpdateRequest,
  audit: AuditContext,
): Promise<DocumentDetail> {
  const current = await getRow(side, tenantId, id);
  assertDraft(side, current, "edited");
  if (current.kind === side.reduction && (patch.partyId !== undefined || patch.controlAccountId !== undefined)) {
    throw new DomainError(
      "INVOICE_INVALID_STATE",
      `A ${DOC_NAMES[side.reduction].toLowerCase()}'s ${side.direction === "AR" ? "customer" : "supplier"} and control account come from its ${side.noun} and can't be changed`,
    );
  }

  const partyId = patch.partyId ?? partyIdOf(side, current);
  const party = await loadTradingParty(side, tenantId, partyId, current.currency);
  const issueDate = patch.issueDate ?? current.issue_date;
  const taxMode = patch.taxMode ?? current.tax_mode;
  const controlAccountId = patch.controlAccountId ?? current.receivable_account_id;
  const lines = patch.lines ?? linesFromRows(await repository.getLines(tenantId, id));
  const built = await buildLines(side, tenantId, taxMode, lines, controlAccountId);

  let dueDate: string | null;
  if (current.kind === side.reduction) {
    dueDate = null;
  } else if (patch.dueDate !== undefined && patch.dueDate !== null) {
    dueDate = patch.dueDate;
  } else if (patch.dueDate === null || patch.issueDate !== undefined || patch.partyId !== undefined) {
    // Recompute from terms when asked to, or when what it depends on changed.
    dueDate = current.kind === side.main ? addDays(issueDate, party.payment_terms_days ?? 0) : null;
  } else {
    dueDate = current.due_date;
  }
  if (dueDate !== null && dueDate < issueDate) {
    throw new DomainError("INVOICE_INVALID_STATE", "The due date can't be before the document date");
  }

  const updated = await repository.updateDraft(
    tenantId,
    id,
    {
      customerId: side.direction === "AR" ? partyId : null,
      supplierId: side.direction === "AP" ? partyId : null,
      supplierReference:
        side.direction === "AP"
          ? patch.supplierReference !== undefined
            ? patch.supplierReference
            : current.supplier_reference
          : null,
      controlAccountId,
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
    assertDraft(side, await getRow(side, tenantId, id), "edited"); // issued meanwhile
  }
  return getDetail(side, tenantId, id);
}

export async function remove(side: Side, tenantId: string, id: string, audit: AuditContext): Promise<void> {
  const current = await getRow(side, tenantId, id);
  assertDraft(side, current, "deleted");
  if (!(await repository.deleteDraft(tenantId, id, audit))) {
    assertDraft(side, await getRow(side, tenantId, id), "deleted");
  }
}

// ---------------------------------------------------------------------
// Issue (post)
// ---------------------------------------------------------------------

/**
 * The issue journal. The control line sits on the side a debt naturally
 * has -- debit for a receivable, credit for a payable -- and a reducing
 * note flips everything. Lines with nothing to post are left out.
 */
function issueJournalLines(side: Side, doc: InvoiceRow, lines: readonly InvoiceLineRow[]): CreateJournalLineRequest[] {
  const flip = (side.direction === "AP") !== (doc.kind === side.reduction);
  const amount = (value: number, natural: "debit" | "credit") => {
    const debit = (natural === "debit") !== flip;
    return { debitMinor: debit ? value : 0, creditMinor: debit ? 0 : value };
  };

  const taxByAccount = new Map<string, number>();
  for (const line of lines) {
    if (line.tax_account_id && Number(line.tax_minor) > 0) {
      taxByAccount.set(line.tax_account_id, (taxByAccount.get(line.tax_account_id) ?? 0) + Number(line.tax_minor));
    }
  }

  return [
    {
      accountId: doc.receivable_account_id!,
      ...amount(Number(doc.total_minor), "debit"),
      ...partyTag(side, partyIdOf(side, doc)),
    },
    ...lines
      .filter((line) => Number(line.net_minor) > 0)
      .map((line) => ({
        accountId: line.income_account_id,
        ...amount(Number(line.net_minor), "credit"),
        narrative: line.description.slice(0, 500),
      })),
    ...Array.from(taxByAccount, ([accountId, value]) => ({
      accountId,
      ...amount(value, "credit"),
      narrative: side.taxNarrative,
    })),
  ];
}

export interface IssueRequest {
  readonly overrideCreditLimit: boolean;
  /** Whether the caller holds invoices:override_credit_limit. */
  readonly mayOverrideCreditLimit: boolean;
}

/** FR-AR-01 credit limit: the customer's balance after this invoice must stay within it. */
async function checkCreditLimit(side: Side, doc: InvoiceRow, request: IssueRequest): Promise<boolean> {
  if (side.direction !== "AR" || doc.kind !== "INVOICE") {
    return false;
  }
  const customer = await loadParty(side, doc.tenant_id, partyIdOf(side, doc));
  if (customer.credit_limit_minor === null || customer.credit_limit_minor === undefined) {
    return false;
  }
  const limit = Number(customer.credit_limit_minor);
  const after = Number(customer.balance_minor) + Number(doc.total_minor);
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

export function assertReducible(side: Side, original: InvoiceRow): void {
  if (original.kind !== side.main || (original.status !== "ISSUED" && original.status !== "PART_PAID")) {
    throw new DomainError(
      "INVOICE_INVALID_STATE",
      `A ${DOC_NAMES[side.reduction].toLowerCase()} needs a ${side.direction === "AR" ? "issued" : "posted"}, unpaid or part-paid ${side.noun}; ${original.number ?? original.id} is ${original.status.toLowerCase()}`,
    );
  }
}

function assertReductionFits(side: Side, original: InvoiceRow, amountMinor: number): void {
  const due = balanceDue(original);
  if (amountMinor > due) {
    throw new DomainError(
      "CREDIT_NOTE_EXCEEDS_BALANCE",
      `The ${DOC_NAMES[side.reduction].toLowerCase()} (${amountMinor}) is more than the ${due} still owed on ${original.number} (minor units)`,
    );
  }
}

export async function issue(
  side: Side,
  tenantId: string,
  id: string,
  request: IssueRequest,
  audit: AuditContext,
): Promise<DocumentDetail> {
  const doc = await getRow(side, tenantId, id);
  assertDraft(side, doc, side.direction === "AR" ? "issued" : "posted");

  let creditLimitOverridden = false;
  let prepared: PreparedJournal | null = null;
  if (doc.kind !== "PROFORMA") {
    creditLimitOverridden = await checkCreditLimit(side, doc, request);
    if (doc.kind === side.reduction) {
      const original = await getRow(side, tenantId, doc.credited_invoice_id!);
      assertReducible(side, original);
      assertReductionFits(side, original, Number(doc.total_minor));
    }
    const lines = await repository.getLines(tenantId, id);
    prepared = await journalsService.prepareJournal(
      {
        tenantId,
        // The document's own id: one issue journal per document, enforced by the database.
        clientUuid: doc.id,
        ...(doc.branch_id ? { branchId: doc.branch_id } : {}),
        date: doc.issue_date,
        currency: doc.currency as CurrencyCode,
        description: DOC_NAMES[doc.kind], // numbered inside the transaction
        source: side.journalSource,
        lines: issueJournalLines(side, doc, lines),
      },
      audit,
    );
  }

  await withTenant(tenantId, async (client) => {
    const locked = await repository.lockInvoice(client, id);
    if (!locked || locked.status !== "DRAFT" || locked.updated_at.valueOf() !== doc.updated_at.valueOf()) {
      throw new DomainError("INVOICE_INVALID_STATE", `The ${side.noun} changed while it was being issued; try again`);
    }
    const original = locked.credited_invoice_id ? await repository.lockInvoice(client, locked.credited_invoice_id) : null;
    if (original) {
      assertReducible(side, original);
      assertReductionFits(side, original, Number(locked.total_minor));
    }

    const number = formatInvoiceNumber(locked.kind, await repository.nextSequence(client, tenantId, locked.kind));
    let description = original
      ? `${DOC_NAMES[locked.kind]} ${number} against ${original.number}`
      : `${DOC_NAMES[locked.kind]} ${number}`;
    if (locked.supplier_reference) {
      description += ` (supplier ref ${locked.supplier_reference})`;
    }
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
          method: side.reduction,
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
  return getDetail(side, tenantId, id);
}

// ---------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------

export async function cancel(
  side: Side,
  tenantId: string,
  id: string,
  reason: string,
  audit: AuditContext,
): Promise<DocumentDetail> {
  const doc = await getRow(side, tenantId, id);
  if (doc.status === "DRAFT") {
    throw new DomainError("INVOICE_INVALID_STATE", "A draft isn't cancelled -- delete it instead");
  }
  if (doc.status === "CANCELLED") {
    throw new DomainError("INVOICE_INVALID_STATE", `${doc.number} is already cancelled`);
  }
  if (doc.kind === side.reduction) {
    throw new DomainError("INVOICE_INVALID_STATE", `A ${DOC_NAMES[side.reduction].toLowerCase()} can't be cancelled once issued`);
  }
  const assertUnpaid = (row: InvoiceRow) => {
    if (Number(row.amount_paid_minor) > 0) {
      throw new DomainError(
        "INVOICE_HAS_PAYMENTS",
        `${row.number} has payments or ${DOC_NAMES[side.reduction].toLowerCase()}s applied; raise a ${DOC_NAMES[side.reduction].toLowerCase()} for the rest instead of cancelling`,
      );
    }
  };
  assertUnpaid(doc);

  const prepared = doc.journal_id
    ? await journalsService.prepareReversal(tenantId, doc.journal_id, `Cancelled ${doc.number}: ${reason}`, audit)
    : null;

  await withTenant(tenantId, async (client) => {
    const locked = await repository.lockInvoice(client, id);
    if (!locked || (locked.status !== "ISSUED" && locked.status !== "PART_PAID")) {
      throw new DomainError("INVOICE_INVALID_STATE", `The ${side.noun} changed while it was being cancelled; try again`);
    }
    assertUnpaid(locked);
    const journal = prepared ? await journalsService.postPreparedJournal(client, prepared, audit) : null;
    await repository.markCancelled(client, locked, journal?.id ?? null, reason, audit);
  });
  return getDetail(side, tenantId, id);
}

// ---------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------

export interface PaymentRequest {
  readonly tenantId: string;
  readonly id: string;
  /** Identity of the allocation and of its journal. */
  readonly clientUuid: string;
  readonly amountMinor: number;
  readonly date: string;
  /** The cash/bank/M-Pesa account the money went into (AR) or came out of (AP). */
  readonly moneyAccountId: string;
  readonly method: InvoicePaymentMethod;
  readonly reference?: string;
  /** Set for an M-Pesa collection (payments module). */
  readonly paymentId?: string;
  /**
   * false: more than the balance is refused (422).
   * true (M-Pesa collections): the money has already arrived, so all of it
   * is posted and anything beyond the balance is recorded as unapplied --
   * customer credit -- rather than refused.
   */
  readonly allowOverpayment: boolean;
}

export interface PaymentResult {
  readonly journalId: string;
  readonly allocation: AllocationRow;
}

function assertPayable(side: Side, row: InvoiceRow, amountMinor: number): void {
  if (row.kind !== side.main) {
    throw new DomainError(
      "INVOICE_INVALID_STATE",
      `Payments are made against ${side.noun}s, not a ${DOC_NAMES[row.kind].toLowerCase()}`,
    );
  }
  if (row.status !== "ISSUED" && row.status !== "PART_PAID") {
    throw new DomainError(
      "INVOICE_INVALID_STATE",
      `${row.number ?? "This draft"} is ${row.status.toLowerCase()}; payments are made against ${side.direction === "AR" ? "issued" : "posted"} ${side.noun}s`,
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

export async function pay(side: Side, request: PaymentRequest, audit: AuditContext): Promise<PaymentResult> {
  const doc = await getRow(side, request.tenantId, request.id);
  if (!request.allowOverpayment) {
    assertPayable(side, doc, request.amountMinor);
  } else if (doc.kind !== side.main || doc.status === "DRAFT") {
    throw new DomainError("INVOICE_INVALID_STATE", `Payments are made against issued ${side.noun}s`);
  }

  const description = `Payment for ${doc.number}`;
  const control: CreateJournalLineRequest = {
    accountId: doc.receivable_account_id!,
    debitMinor: side.direction === "AP" ? request.amountMinor : 0,
    creditMinor: side.direction === "AR" ? request.amountMinor : 0,
    narrative: description,
    ...partyTag(side, partyIdOf(side, doc)),
  };
  const money: CreateJournalLineRequest = {
    accountId: request.moneyAccountId,
    debitMinor: side.direction === "AR" ? request.amountMinor : 0,
    creditMinor: side.direction === "AP" ? request.amountMinor : 0,
    narrative: description,
  };
  const prepared = await journalsService.prepareJournal(
    {
      tenantId: request.tenantId,
      clientUuid: request.clientUuid,
      ...(doc.branch_id ? { branchId: doc.branch_id } : {}),
      date: request.date,
      currency: doc.currency as CurrencyCode,
      description,
      ...(request.reference !== undefined ? { reference: request.reference } : {}),
      source: "PAYMENT",
      lines: side.direction === "AR" ? [money, control] : [control, money],
    },
    audit,
  );

  return withTenant(request.tenantId, async (client) => {
    const locked = (await repository.lockInvoice(client, request.id))!;
    let applied = request.amountMinor;
    if (!request.allowOverpayment) {
      assertPayable(side, locked, request.amountMinor); // re-checked under the lock
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
        receivedAccountId: request.moneyAccountId,
        ...(request.reference !== undefined ? { reference: request.reference } : {}),
        journalId: journal.id,
        ...(request.paymentId !== undefined ? { paymentId: request.paymentId } : {}),
      },
      audit,
    );
    return { journalId: journal.id, allocation };
  });
}

/** Throws unless a payment of `amountMinor` may be taken against this document right now. */
export async function assertPayableNow(side: Side, tenantId: string, id: string, amountMinor: number): Promise<InvoiceRow> {
  const doc = await getRow(side, tenantId, id);
  assertPayable(side, doc, amountMinor);
  return doc;
}

// ---------------------------------------------------------------------
// Credit / debit notes
// ---------------------------------------------------------------------

export interface ReductionRequest {
  readonly tenantId: string;
  readonly originalId: string;
  readonly clientUuid: string;
  readonly issueDate?: string;
  readonly taxMode?: TaxMode;
  readonly reference?: string;
  readonly notes?: string;
  readonly lines: readonly LineRequest[];
}

/** A DRAFT credit note (AR) or debit note (AP) against an issued document; issuing it applies it. */
export async function createReduction(side: Side, request: ReductionRequest, audit: AuditContext): Promise<DocumentDetail> {
  const original = await getRow(side, request.tenantId, request.originalId);
  assertReducible(side, original);
  const taxMode = request.taxMode ?? original.tax_mode;
  const built = await buildLines(side, request.tenantId, taxMode, request.lines, original.receivable_account_id);
  assertReductionFits(side, original, built.totalMinor + (await repository.sumDraftCreditNotes(request.tenantId, original.id)));

  const note = await repository.insertInvoice(
    {
      tenantId: request.tenantId,
      clientUuid: request.clientUuid,
      ...(original.branch_id ? { branchId: original.branch_id } : {}),
      direction: side.direction,
      kind: side.reduction,
      ...partyTag(side, partyIdOf(side, original)),
      issueDate: request.issueDate ?? todayInNairobi(),
      dueDate: null,
      currency: original.currency,
      controlAccountId: original.receivable_account_id!,
      taxMode,
      ...built,
      ...(request.reference !== undefined ? { reference: request.reference } : {}),
      ...(request.notes !== undefined ? { notes: request.notes } : {}),
      creditedInvoiceId: original.id,
    },
    audit,
  );
  return getDetail(side, request.tenantId, note.id);
}

// ---------------------------------------------------------------------
// Aging support
// ---------------------------------------------------------------------

/** Invoices (AR) or bills (AP) with something still owed at the end of `asOf`. */
export async function listOpenAsOf(side: Side, tenantId: string, asOf: string, partyId?: string) {
  return repository.listOpenInvoicesAsOf(tenantId, side.direction, asOf, partyId);
}
