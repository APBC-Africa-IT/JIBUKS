/**
 * Invoices repository -- sales documents (direction AR) and supplier bills
 * (direction AP) share these tables.
 *
 * The ONLY file permitted to write raw SQL against `invoices`,
 * `invoice_lines`, `invoice_allocations` and `invoice_number_sequences`
 * (AD-02). Every write is audit-logged in the same transaction (FR-AUD-01).
 *
 * Issuing, cancelling and applying payments post a journal in the SAME
 * transaction as the invoice change, so the service opens that transaction
 * (withTenant) and calls the client-taking functions below inside it,
 * alongside journalsService.postPreparedJournal.
 */

import { randomUUID } from "node:crypto";
import { recordAuditLog, withTenant, readAsTenant, type AuditContext } from "@jibuks/db";
import type { InvoiceKind, InvoicePaymentMethod, InvoiceStatus, TaxMode } from "@jibuks/domain";

/** A transaction-scoped client, as handed out by withTenant. */
export type TxClient = Parameters<Parameters<typeof withTenant>[1]>[0];

export interface InvoiceRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly client_uuid: string;
  readonly branch_id: string | null;
  readonly direction: "AR" | "AP";
  readonly kind: InvoiceKind;
  readonly status: InvoiceStatus;
  readonly number: string | null;
  /** Set on AR rows. */
  readonly customer_id: string | null;
  /** Set on AP rows. */
  readonly supplier_id: string | null;
  /** AP: the supplier's own invoice number. */
  readonly supplier_reference: string | null;
  readonly issue_date: string;
  readonly due_date: string | null;
  readonly currency: string;
  /** The control account: Accounts Receivable on AR rows, Accounts Payable on AP rows. */
  readonly receivable_account_id: string | null;
  readonly tax_mode: TaxMode;
  readonly subtotal_minor: string; // bigint
  readonly tax_minor: string;
  readonly total_minor: string;
  readonly amount_paid_minor: string;
  readonly reference: string | null;
  readonly notes: string | null;
  readonly journal_id: string | null;
  readonly cancel_journal_id: string | null;
  readonly credited_invoice_id: string | null;
  readonly proforma_id: string | null;
  readonly credit_limit_overridden: boolean;
  readonly created_by: string;
  readonly issued_by: string | null;
  readonly cancelled_by: string | null;
  readonly cancel_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly issued_at: string | null;
  readonly cancelled_at: string | null;
  /** CASH_SALE only: how it was paid. */
  readonly payment_method: InvoicePaymentMethod | null;
  /** CASH_SALE / CHEQUE: the money account -- where a sale's money went, or the bank a cheque is drawn on. */
  readonly deposit_account_id: string | null;
  /** CHEQUE only: the number on the cheque leaf. */
  readonly cheque_number: string | null;
  /** Internal note; `notes` is what the customer sees. */
  readonly memo: string | null;
  readonly po_number: string | null;
  readonly ship_to: string | null;
  readonly shipping_date: string | null;
  /** The terms due_date was worked out from; null on notes and on rows from before terms were stored. */
  readonly payment_terms_days: number | null;
}

/** An InvoiceRow plus its customer's or supplier's name -- what lists and details show. */
export interface InvoiceListRow extends InvoiceRow {
  /** Null only for a walk-in cash sale. */
  readonly party_name: string | null;
}

export interface InvoiceLineRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly invoice_id: string;
  readonly line_no: number;
  /** What was sold (CASH_SALE lines); null on other documents. */
  readonly item_name: string | null;
  /** The catalogue item the line was picked from, if any. */
  readonly item_id: string | null;
  readonly description: string;
  readonly quantity: string; // numeric
  readonly unit_price_minor: string;
  /** Set when the line was entered as a total; then it, not quantity x unit price, is the amount. */
  readonly amount_minor: string | null;
  /** Income account on AR lines, expense/asset account on AP lines. */
  readonly income_account_id: string;
  readonly tax_rate_bps: number;
  readonly tax_account_id: string | null;
  readonly net_minor: string;
  readonly tax_minor: string;
  readonly total_minor: string;
}

export interface AllocationRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly client_uuid: string;
  readonly invoice_id: string;
  readonly method: InvoicePaymentMethod | "CREDIT_NOTE" | "DEBIT_NOTE";
  readonly amount_minor: string;
  readonly unapplied_minor: string;
  readonly date: string;
  /** Where the money went (AR) or came from (AP). */
  readonly received_account_id: string | null;
  readonly reference: string | null;
  readonly journal_id: string;
  readonly payment_id: string | null;
  readonly credit_note_id: string | null;
  /** The customer payment this applies (customerPayments module); null on credit notes and bill payments. */
  readonly customer_payment_id: string | null;
  readonly created_by: string;
  readonly created_at: string;
}

export interface InvoiceDetail extends InvoiceListRow {
  readonly lines: InvoiceLineRow[];
  readonly allocations: AllocationRow[];
}

export interface LineInput {
  readonly itemId?: string;
  readonly itemName?: string;
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly amountMinor?: number;
  /** Income (AR) or expense/asset (AP) account. */
  readonly accountId: string;
  readonly taxRateBps: number;
  readonly taxAccountId?: string;
  readonly netMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
}

export interface InsertInvoiceInput {
  readonly tenantId: string;
  readonly clientUuid: string;
  readonly branchId?: string;
  readonly direction: "AR" | "AP";
  readonly kind: InvoiceKind;
  readonly customerId?: string;
  readonly supplierId?: string;
  readonly supplierReference?: string;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly currency: string;
  /** Receivable (AR) or payable (AP) account. */
  readonly controlAccountId?: string;
  readonly taxMode: TaxMode;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly reference?: string;
  readonly notes?: string;
  readonly creditedInvoiceId?: string;
  readonly proformaId?: string;
  readonly memo?: string;
  readonly poNumber?: string;
  readonly shipTo?: string;
  readonly shippingDate?: string;
  readonly paymentTermsDays: number | null;
  readonly lines: readonly LineInput[];
}

const SELECT_WITH_PARTY = `
  SELECT i.*, COALESCE(c.name, s.name) AS party_name
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    LEFT JOIN suppliers s ON s.id = i.supplier_id`;

async function insertLines(client: TxClient, tenantId: string, invoiceId: string, lines: readonly LineInput[]) {
  const rows: InvoiceLineRow[] = [];
  for (const [index, line] of lines.entries()) {
    const result = await client.query<InvoiceLineRow>(
      `INSERT INTO invoice_lines
         (id, tenant_id, invoice_id, line_no, description, quantity, unit_price_minor, income_account_id,
          tax_rate_bps, tax_account_id, net_minor, tax_minor, total_minor, item_name, item_id, amount_minor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        randomUUID(),
        tenantId,
        invoiceId,
        index + 1,
        line.description,
        line.quantity,
        line.unitPriceMinor,
        line.accountId,
        line.taxRateBps,
        line.taxAccountId ?? null,
        line.netMinor,
        line.taxMinor,
        line.totalMinor,
        line.itemName ?? null,
        line.itemId ?? null,
        line.amountMinor ?? null,
      ],
    );
    rows.push(result.rows[0]!);
  }
  return rows;
}

export async function insertInvoice(input: InsertInvoiceInput, audit: AuditContext): Promise<InvoiceRow> {
  return withTenant(input.tenantId, async (client) => {
    const result = await client.query<InvoiceRow>(
      `INSERT INTO invoices
         (id, tenant_id, client_uuid, branch_id, kind, customer_id, issue_date, due_date, currency,
          receivable_account_id, tax_mode, subtotal_minor, tax_minor, total_minor, reference, notes,
          credited_invoice_id, proforma_id, created_by, direction, supplier_id, supplier_reference,
          memo, po_number, ship_to, shipping_date, payment_terms_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
               $23, $24, $25, $26, $27)
       RETURNING *`,
      [
        randomUUID(),
        input.tenantId,
        input.clientUuid,
        input.branchId ?? null,
        input.kind,
        input.customerId ?? null,
        input.issueDate,
        input.dueDate,
        input.currency,
        input.controlAccountId ?? null,
        input.taxMode,
        input.subtotalMinor,
        input.taxMinor,
        input.totalMinor,
        input.reference ?? null,
        input.notes ?? null,
        input.creditedInvoiceId ?? null,
        input.proformaId ?? null,
        audit.actorUserId,
        input.direction,
        input.supplierId ?? null,
        input.supplierReference ?? null,
        input.memo ?? null,
        input.poNumber ?? null,
        input.shipTo ?? null,
        input.shippingDate ?? null,
        input.paymentTermsDays,
      ],
    );
    const invoice = result.rows[0]!;
    const lines = await insertLines(client, input.tenantId, invoice.id, input.lines);
    await recordAuditLog(client, {
      tenantId: input.tenantId,
      action: "CREATE",
      entityType: "invoice",
      entityId: invoice.id,
      afterState: { ...invoice, lines },
      context: audit,
    });
    return invoice;
  });
}

export interface InsertSettledInput {
  /** Chosen before the transaction: it is also the journal's clientUuid. */
  readonly id: string;
  readonly tenantId: string;
  readonly clientUuid: string;
  readonly branchId?: string;
  readonly kind: "CASH_SALE" | "CHEQUE";
  readonly customerId?: string;
  readonly supplierId?: string;
  readonly issueDate: string;
  readonly currency: string;
  /** CASH_SALE only. */
  readonly paymentMethod?: InvoicePaymentMethod;
  /** Where a sale's money went, or the bank a cheque is drawn on. */
  readonly moneyAccountId: string;
  /** CHEQUE only. */
  readonly chequeNumber?: string;
  readonly taxMode: TaxMode;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly reference?: string;
  readonly notes?: string;
  readonly memo?: string;
  readonly number: string;
  readonly journalId: string;
  readonly lines: readonly LineInput[];
}

/**
 * A document settled on the spot -- a cash sale (AR) or a cheque (AP) --
 * inserted already numbered, posted and PAID, inside the transaction that
 * posted its journal.
 */
export async function insertSettledDocument(client: TxClient, input: InsertSettledInput, audit: AuditContext): Promise<InvoiceRow> {
  const result = await client.query<InvoiceRow>(
    `INSERT INTO invoices
       (id, tenant_id, client_uuid, branch_id, direction, kind, status, number, customer_id, issue_date, currency,
        payment_method, deposit_account_id, tax_mode, subtotal_minor, tax_minor, total_minor, amount_paid_minor,
        reference, notes, memo, journal_id, created_by, issued_by, issued_at, supplier_id, cheque_number)
     VALUES ($1, $2, $3, $4, $20, $21, 'PAID', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14,
             $15, $16, $17, $18, $19, $19, now(), $22, $23)
     RETURNING *`,
    [
      input.id,
      input.tenantId,
      input.clientUuid,
      input.branchId ?? null,
      input.number,
      input.customerId ?? null,
      input.issueDate,
      input.currency,
      input.paymentMethod ?? null,
      input.moneyAccountId,
      input.taxMode,
      input.subtotalMinor,
      input.taxMinor,
      input.totalMinor,
      input.reference ?? null,
      input.notes ?? null,
      input.memo ?? null,
      input.journalId,
      audit.actorUserId,
      input.kind === "CHEQUE" ? "AP" : "AR",
      input.kind,
      input.supplierId ?? null,
      input.chequeNumber ?? null,
    ],
  );
  const doc = result.rows[0]!;
  const lines = await insertLines(client, input.tenantId, doc.id, input.lines);
  await recordAuditLog(client, {
    tenantId: input.tenantId,
    action: "CREATE",
    entityType: "invoice",
    entityId: doc.id,
    afterState: { ...doc, lines },
    context: audit,
  });
  return doc;
}

export interface UpdateDraftInput {
  readonly customerId: string | null;
  readonly supplierId: string | null;
  readonly supplierReference: string | null;
  readonly controlAccountId: string | null;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly taxMode: TaxMode;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly reference: string | null;
  readonly notes: string | null;
  readonly memo: string | null;
  readonly poNumber: string | null;
  readonly shipTo: string | null;
  readonly shippingDate: string | null;
  readonly paymentTermsDays: number | null;
  /** Replaces every line. */
  readonly lines: readonly LineInput[];
}

/** Rewrites a DRAFT. Returns null if it is no longer a draft. */
export async function updateDraft(
  tenantId: string,
  invoiceId: string,
  input: UpdateDraftInput,
  audit: AuditContext,
): Promise<InvoiceRow | null> {
  return withTenant(tenantId, async (client) => {
    const before = await lockInvoice(client, invoiceId);
    if (!before || before.status !== "DRAFT") {
      return null;
    }
    const beforeLines = await client.query<InvoiceLineRow>(
      `SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no`,
      [invoiceId],
    );
    const result = await client.query<InvoiceRow>(
      `UPDATE invoices
          SET customer_id = $2, receivable_account_id = $3, issue_date = $4, due_date = $5, tax_mode = $6,
              subtotal_minor = $7, tax_minor = $8, total_minor = $9, reference = $10, notes = $11,
              supplier_id = $12, supplier_reference = $13, memo = $14, po_number = $15, ship_to = $16,
              shipping_date = $17, payment_terms_days = $18, updated_at = now()
        WHERE id = $1
       RETURNING *`,
      [
        invoiceId,
        input.customerId,
        input.controlAccountId,
        input.issueDate,
        input.dueDate,
        input.taxMode,
        input.subtotalMinor,
        input.taxMinor,
        input.totalMinor,
        input.reference,
        input.notes,
        input.supplierId,
        input.supplierReference,
        input.memo,
        input.poNumber,
        input.shipTo,
        input.shippingDate,
        input.paymentTermsDays,
      ],
    );
    await client.query(`DELETE FROM invoice_lines WHERE invoice_id = $1`, [invoiceId]);
    const lines = await insertLines(client, tenantId, invoiceId, input.lines);
    const invoice = result.rows[0]!;
    await recordAuditLog(client, {
      tenantId,
      action: "UPDATE",
      entityType: "invoice",
      entityId: invoiceId,
      beforeState: { ...before, lines: beforeLines.rows },
      afterState: { ...invoice, lines },
      context: audit,
    });
    return invoice;
  });
}

/** Deletes a DRAFT -- never transacted against, so hard deletion is allowed (DR-07). */
export async function deleteDraft(tenantId: string, invoiceId: string, audit: AuditContext): Promise<boolean> {
  return withTenant(tenantId, async (client) => {
    const before = await lockInvoice(client, invoiceId);
    if (!before || before.status !== "DRAFT") {
      return false;
    }
    const lines = await client.query<InvoiceLineRow>(`SELECT * FROM invoice_lines WHERE invoice_id = $1`, [invoiceId]);
    await client.query(`DELETE FROM invoices WHERE id = $1`, [invoiceId]);
    await recordAuditLog(client, {
      tenantId,
      action: "DELETE",
      entityType: "invoice",
      entityId: invoiceId,
      beforeState: { ...before, lines: lines.rows },
      context: audit,
    });
    return true;
  });
}

export async function getInvoice(tenantId: string, invoiceId: string): Promise<InvoiceRow | null> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<InvoiceRow>(`SELECT * FROM invoices WHERE id = $1`, [invoiceId]);
    return result.rows[0] ?? null;
  });
}

export async function getInvoiceDetail(tenantId: string, invoiceId: string): Promise<InvoiceDetail | null> {
  return readAsTenant(tenantId, async (client) => {
    const invoice = await client.query<InvoiceListRow>(`${SELECT_WITH_PARTY} WHERE i.id = $1`, [invoiceId]);
    if (!invoice.rows[0]) {
      return null;
    }
    const lines = await client.query<InvoiceLineRow>(
      `SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no`,
      [invoiceId],
    );
    const allocations = await client.query<AllocationRow>(
      `SELECT * FROM invoice_allocations WHERE invoice_id = $1 ORDER BY created_at, id`,
      [invoiceId],
    );
    return { ...invoice.rows[0], lines: lines.rows, allocations: allocations.rows };
  });
}

export async function getLines(tenantId: string, invoiceId: string): Promise<InvoiceLineRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<InvoiceLineRow>(
      `SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no`,
      [invoiceId],
    );
    return result.rows;
  });
}

export async function findAllocationByClientUuid(tenantId: string, clientUuid: string): Promise<AllocationRow | null> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<AllocationRow>(`SELECT * FROM invoice_allocations WHERE client_uuid = $1`, [
      clientUuid,
    ]);
    return result.rows[0] ?? null;
  });
}

/** Credit notes raised against an invoice that are still drafts. */
export async function sumDraftCreditNotes(tenantId: string, invoiceId: string): Promise<number> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(total_minor), 0)::text AS total
         FROM invoices WHERE credited_invoice_id = $1 AND status = 'DRAFT'`,
      [invoiceId],
    );
    return Number(result.rows[0]!.total);
  });
}

export interface ListFilters {
  readonly direction: "AR" | "AP";
  /** Only these kinds -- keeps cash sales out of invoice lists and the reverse. */
  readonly kinds: readonly InvoiceKind[];
  /** A stored status, or OVERDUE (derived). */
  readonly status?: InvoiceStatus | "OVERDUE";
  /** The customer (AR) or supplier (AP). */
  readonly partyId?: string;
  readonly from?: string;
  readonly to?: string;
  /** Today in Africa/Nairobi -- the cutoff for OVERDUE. */
  readonly today: string;
  readonly limit: number;
  /** Position after which to continue: the last row of the previous page. */
  readonly after?: { readonly createdAt: string; readonly id: string };
}

const OVERDUE_SQL = (todayParam: string) =>
  `(i.kind IN ('INVOICE', 'BILL') AND i.status IN ('ISSUED', 'PART_PAID') AND i.due_date < ${todayParam})`;

/** A list row plus its exact (microsecond) created_at, for building the next cursor. */
export interface InvoicePageRow extends InvoiceListRow {
  readonly sort_key: string;
}

/** Newest first. Fetches limit + 1 rows so the caller can tell whether more exist. */
export async function listInvoices(tenantId: string, filters: ListFilters): Promise<InvoicePageRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };

    where.push(`i.direction = ${add(filters.direction)}`);
    where.push(`i.kind = ANY(${add(filters.kinds)}::text[])`);
    if (filters.status === "OVERDUE") {
      where.push(OVERDUE_SQL(`${add(filters.today)}::date`));
    } else if (filters.status !== undefined) {
      where.push(`i.status = ${add(filters.status)}`);
      if (filters.status === "ISSUED" || filters.status === "PART_PAID") {
        where.push(`NOT ${OVERDUE_SQL(`${add(filters.today)}::date`)}`);
      }
    }
    if (filters.partyId !== undefined) {
      where.push(`${filters.direction === "AR" ? "i.customer_id" : "i.supplier_id"} = ${add(filters.partyId)}`);
    }
    if (filters.from !== undefined) {
      where.push(`i.issue_date >= ${add(filters.from)}`);
    }
    if (filters.to !== undefined) {
      where.push(`i.issue_date <= ${add(filters.to)}`);
    }
    if (filters.after !== undefined) {
      where.push(`(i.created_at, i.id) < (${add(filters.after.createdAt)}::timestamptz, ${add(filters.after.id)}::uuid)`);
    }

    const result = await client.query<InvoicePageRow>(
      `SELECT i.*, COALESCE(c.name, s.name) AS party_name, i.created_at::text AS sort_key
         FROM invoices i
         LEFT JOIN customers c ON c.id = i.customer_id
         LEFT JOIN suppliers s ON s.id = i.supplier_id
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT ${add(filters.limit + 1)}`,
      params,
    );
    return result.rows;
  });
}

/** How a journal relates to a sales document: it issued or cancelled one.
 * (Payments are named by the customerPayments module.) */
export interface JournalDocumentLinkRow {
  readonly journal_id: string;
  readonly link: "ISSUE" | "CANCEL";
  readonly document_id: string;
  readonly kind: InvoiceKind;
  readonly number: string | null;
  /** ISSUE of a credit note: the invoice it credits. */
  readonly credited_invoice_id: string | null;
  readonly credited_invoice_number: string | null;
}

/** The AR documents the given journals issued or cancelled. */
export async function listJournalDocumentLinks(tenantId: string, journalIds: readonly string[]): Promise<JournalDocumentLinkRow[]> {
  if (journalIds.length === 0) {
    return [];
  }
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<JournalDocumentLinkRow>(
      `SELECT i.journal_id, 'ISSUE' AS link, i.id AS document_id, i.kind, i.number,
              o.id AS credited_invoice_id, o.number AS credited_invoice_number
         FROM invoices i
         LEFT JOIN invoices o ON o.id = i.credited_invoice_id
        WHERE i.direction = 'AR' AND i.journal_id = ANY($1::uuid[])
       UNION ALL
       SELECT i.cancel_journal_id, 'CANCEL', i.id, i.kind, i.number, NULL, NULL
         FROM invoices i
        WHERE i.direction = 'AR' AND i.cancel_journal_id = ANY($1::uuid[])`,
      [journalIds],
    );
    return result.rows;
  });
}

// ---------------------------------------------------------------------
// Transaction primitives -- called inside a service-opened withTenant.
// ---------------------------------------------------------------------

/** Locks an invoice row for the rest of the transaction. */
export async function lockInvoice(client: TxClient, invoiceId: string): Promise<InvoiceRow | null> {
  const result = await client.query<InvoiceRow>(`SELECT * FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);
  return result.rows[0] ?? null;
}

/** The next number for `kind`. The row lock it takes is held until commit, so numbers are gapless. */
export async function nextSequence(client: TxClient, tenantId: string, kind: InvoiceKind): Promise<number> {
  const result = await client.query<{ last_value: number }>(
    `INSERT INTO invoice_number_sequences (tenant_id, kind, last_value)
     VALUES ($1, $2, 1)
     ON CONFLICT (tenant_id, kind) DO UPDATE SET last_value = invoice_number_sequences.last_value + 1
     RETURNING last_value`,
    [tenantId, kind],
  );
  return result.rows[0]!.last_value;
}

export interface MarkIssuedInput {
  readonly number: string;
  readonly journalId: string | null;
  readonly creditLimitOverridden: boolean;
}

export async function markIssued(
  client: TxClient,
  before: InvoiceRow,
  input: MarkIssuedInput,
  audit: AuditContext,
): Promise<InvoiceRow> {
  const result = await client.query<InvoiceRow>(
    `UPDATE invoices
        SET status = 'ISSUED', number = $2, journal_id = $3, credit_limit_overridden = $4,
            issued_by = $5, issued_at = now(), updated_at = now()
      WHERE id = $1
     RETURNING *`,
    [before.id, input.number, input.journalId, input.creditLimitOverridden, audit.actorUserId],
  );
  const invoice = result.rows[0]!;
  await recordAuditLog(client, {
    tenantId: before.tenant_id,
    action: "UPDATE",
    entityType: "invoice",
    entityId: before.id,
    beforeState: before,
    afterState: invoice,
    context: audit,
  });
  return invoice;
}

export async function markCancelled(
  client: TxClient,
  before: InvoiceRow,
  cancelJournalId: string | null,
  reason: string,
  audit: AuditContext,
): Promise<InvoiceRow> {
  const result = await client.query<InvoiceRow>(
    `UPDATE invoices
        SET status = 'CANCELLED', cancel_journal_id = $2, cancel_reason = $3,
            cancelled_by = $4, cancelled_at = now(), updated_at = now()
      WHERE id = $1
     RETURNING *`,
    [before.id, cancelJournalId, reason, audit.actorUserId],
  );
  const invoice = result.rows[0]!;
  await recordAuditLog(client, {
    tenantId: before.tenant_id,
    action: "UPDATE",
    entityType: "invoice",
    entityId: before.id,
    beforeState: before,
    afterState: invoice,
    context: audit,
  });
  return invoice;
}

export interface InsertAllocationInput {
  readonly clientUuid: string;
  readonly method: InvoicePaymentMethod | "CREDIT_NOTE" | "DEBIT_NOTE";
  readonly amountMinor: number;
  readonly unappliedMinor: number;
  readonly date: string;
  readonly receivedAccountId?: string;
  readonly reference?: string;
  readonly journalId: string;
  readonly paymentId?: string;
  readonly creditNoteId?: string;
  readonly customerPaymentId?: string;
}

/**
 * Records an amount applied to `before` (already locked) and moves its
 * status to PART_PAID or PAID to match. A CANCELLED invoice keeps its
 * status; anything received for it is all unapplied.
 */
export async function applyAllocation(
  client: TxClient,
  before: InvoiceRow,
  input: InsertAllocationInput,
  audit: AuditContext,
): Promise<{ invoice: InvoiceRow; allocation: AllocationRow }> {
  const allocationResult = await client.query<AllocationRow>(
    `INSERT INTO invoice_allocations
       (id, tenant_id, client_uuid, invoice_id, method, amount_minor, unapplied_minor, date,
        received_account_id, reference, journal_id, payment_id, credit_note_id, customer_payment_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      randomUUID(),
      before.tenant_id,
      input.clientUuid,
      before.id,
      input.method,
      input.amountMinor,
      input.unappliedMinor,
      input.date,
      input.receivedAccountId ?? null,
      input.reference ?? null,
      input.journalId,
      input.paymentId ?? null,
      input.creditNoteId ?? null,
      input.customerPaymentId ?? null,
      audit.actorUserId,
    ],
  );
  const allocation = allocationResult.rows[0]!;
  await recordAuditLog(client, {
    tenantId: before.tenant_id,
    action: "CREATE",
    entityType: "invoice_allocation",
    entityId: allocation.id,
    afterState: allocation,
    context: audit,
  });

  if (input.amountMinor === 0) {
    return { invoice: before, allocation };
  }
  const result = await client.query<InvoiceRow>(
    `UPDATE invoices
        SET amount_paid_minor = amount_paid_minor + $2,
            status = CASE WHEN amount_paid_minor + $2 >= total_minor THEN 'PAID' ELSE 'PART_PAID' END,
            updated_at = now()
      WHERE id = $1
     RETURNING *`,
    [before.id, input.amountMinor],
  );
  const invoice = result.rows[0]!;
  await recordAuditLog(client, {
    tenantId: before.tenant_id,
    action: "UPDATE",
    entityType: "invoice",
    entityId: before.id,
    beforeState: before,
    afterState: invoice,
    context: audit,
  });
  return { invoice, allocation };
}

/**
 * Records `amountMinor` more of an issued credit note (already locked) as
 * used -- applied to an invoice or refunded. A credit note's
 * amount_paid_minor is what of it has been used; the database refuses
 * using more than its total.
 */
export async function useCredit(client: TxClient, before: InvoiceRow, amountMinor: number, audit: AuditContext): Promise<InvoiceRow> {
  const result = await client.query<InvoiceRow>(
    `UPDATE invoices SET amount_paid_minor = amount_paid_minor + $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [before.id, amountMinor],
  );
  const note = result.rows[0]!;
  await recordAuditLog(client, {
    tenantId: before.tenant_id,
    action: "UPDATE",
    entityType: "invoice",
    entityId: before.id,
    beforeState: before,
    afterState: note,
    context: audit,
  });
  return note;
}

/** A customer's issued credit notes with something left to use, oldest first. */
export async function listCreditNotesWithCredit(tenantId: string, customerId: string): Promise<InvoiceRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<InvoiceRow>(
      `SELECT * FROM invoices
        WHERE direction = 'AR' AND kind = 'CREDIT_NOTE' AND status = 'ISSUED' AND customer_id = $1
          AND amount_paid_minor < total_minor
        ORDER BY issue_date, created_at, id`,
      [customerId],
    );
    return result.rows;
  });
}

/** A customer's invoices that can take a payment now, oldest due first (issue date when there's no due date). */
export async function listPayableInvoices(tenantId: string, customerId: string): Promise<InvoiceRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<InvoiceRow>(
      `SELECT * FROM invoices
        WHERE direction = 'AR' AND kind = 'INVOICE' AND status IN ('ISSUED', 'PART_PAID') AND customer_id = $1
        ORDER BY COALESCE(due_date, issue_date), issue_date, created_at, id`,
      [customerId],
    );
    return result.rows;
  });
}

export interface OpenInvoiceRow {
  readonly id: string;
  readonly number: string;
  /** The customer (AR) or supplier (AP). */
  readonly party_id: string;
  readonly party_name: string;
  readonly issue_date: string;
  readonly due_date: string | null;
  readonly total_minor: string;
  /** What was still owed at the as-of date. */
  readonly open_minor: string;
}

/**
 * Invoices (AR) or bills (AP) that had something left to pay at the end of `asOf`: issued on
 * or before it, not yet cancelled then, and not covered by payments and
 * credit notes dated on or before it. Reconstructed from allocation dates,
 * so a past as-of date gives the past picture.
 */
export async function listOpenInvoicesAsOf(
  tenantId: string,
  direction: "AR" | "AP",
  asOf: string,
  partyId?: string,
): Promise<OpenInvoiceRow[]> {
  const party = direction === "AR" ? "customer_id" : "supplier_id";
  return readAsTenant(tenantId, async (client) => {
    const params: unknown[] = [asOf];
    if (partyId !== undefined) {
      params.push(partyId);
    }
    const result = await client.query<OpenInvoiceRow>(
      `SELECT * FROM (
         SELECT i.id, i.number, i.${party} AS party_id, COALESCE(c.name, s.name) AS party_name,
                i.issue_date, i.due_date, i.total_minor,
                (i.total_minor - COALESCE(
                   (SELECT SUM(a.amount_minor) FROM invoice_allocations a WHERE a.invoice_id = i.id AND a.date <= $1::date),
                   0))::text AS open_minor
           FROM invoices i
           LEFT JOIN customers c ON c.id = i.customer_id
           LEFT JOIN suppliers s ON s.id = i.supplier_id
          WHERE i.kind = '${direction === "AR" ? "INVOICE" : "BILL"}'
            AND i.status <> 'DRAFT'
            AND i.issue_date <= $1::date
            AND (i.status <> 'CANCELLED' OR (i.cancelled_at AT TIME ZONE 'Africa/Nairobi')::date > $1::date)
            ${partyId !== undefined ? `AND i.${party} = $2` : ""}
       ) open
       WHERE open.open_minor::bigint > 0
       ORDER BY open.due_date NULLS FIRST, open.issue_date, open.number`,
      params,
    );
    return result.rows;
  });
}
