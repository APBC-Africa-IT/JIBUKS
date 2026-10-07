/**
 * Invoices repository.
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
  readonly direction: "AR";
  readonly kind: InvoiceKind;
  readonly status: InvoiceStatus;
  readonly number: string | null;
  readonly customer_id: string;
  readonly issue_date: string;
  readonly due_date: string | null;
  readonly currency: string;
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
}

/** An InvoiceRow plus its customer's name -- what lists and details show. */
export interface InvoiceListRow extends InvoiceRow {
  readonly customer_name: string;
}

export interface InvoiceLineRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly invoice_id: string;
  readonly line_no: number;
  readonly description: string;
  readonly quantity: string; // numeric
  readonly unit_price_minor: string;
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
  readonly method: InvoicePaymentMethod | "CREDIT_NOTE";
  readonly amount_minor: string;
  readonly unapplied_minor: string;
  readonly date: string;
  readonly received_account_id: string | null;
  readonly reference: string | null;
  readonly journal_id: string;
  readonly payment_id: string | null;
  readonly credit_note_id: string | null;
  readonly created_by: string;
  readonly created_at: string;
}

export interface InvoiceDetail extends InvoiceListRow {
  readonly lines: InvoiceLineRow[];
  readonly allocations: AllocationRow[];
}

export interface LineInput {
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly incomeAccountId: string;
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
  readonly kind: InvoiceKind;
  readonly customerId: string;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly currency: string;
  readonly receivableAccountId?: string;
  readonly taxMode: TaxMode;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly reference?: string;
  readonly notes?: string;
  readonly creditedInvoiceId?: string;
  readonly proformaId?: string;
  readonly lines: readonly LineInput[];
}

const SELECT_WITH_CUSTOMER = `
  SELECT i.*, c.name AS customer_name
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id`;

async function insertLines(client: TxClient, tenantId: string, invoiceId: string, lines: readonly LineInput[]) {
  const rows: InvoiceLineRow[] = [];
  for (const [index, line] of lines.entries()) {
    const result = await client.query<InvoiceLineRow>(
      `INSERT INTO invoice_lines
         (id, tenant_id, invoice_id, line_no, description, quantity, unit_price_minor, income_account_id,
          tax_rate_bps, tax_account_id, net_minor, tax_minor, total_minor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        randomUUID(),
        tenantId,
        invoiceId,
        index + 1,
        line.description,
        line.quantity,
        line.unitPriceMinor,
        line.incomeAccountId,
        line.taxRateBps,
        line.taxAccountId ?? null,
        line.netMinor,
        line.taxMinor,
        line.totalMinor,
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
          credited_invoice_id, proforma_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING *`,
      [
        randomUUID(),
        input.tenantId,
        input.clientUuid,
        input.branchId ?? null,
        input.kind,
        input.customerId,
        input.issueDate,
        input.dueDate,
        input.currency,
        input.receivableAccountId ?? null,
        input.taxMode,
        input.subtotalMinor,
        input.taxMinor,
        input.totalMinor,
        input.reference ?? null,
        input.notes ?? null,
        input.creditedInvoiceId ?? null,
        input.proformaId ?? null,
        audit.actorUserId,
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

export interface UpdateDraftInput {
  readonly customerId: string;
  readonly receivableAccountId: string | null;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly taxMode: TaxMode;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly reference: string | null;
  readonly notes: string | null;
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
              updated_at = now()
        WHERE id = $1
       RETURNING *`,
      [
        invoiceId,
        input.customerId,
        input.receivableAccountId,
        input.issueDate,
        input.dueDate,
        input.taxMode,
        input.subtotalMinor,
        input.taxMinor,
        input.totalMinor,
        input.reference,
        input.notes,
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
    const invoice = await client.query<InvoiceListRow>(`${SELECT_WITH_CUSTOMER} WHERE i.id = $1`, [invoiceId]);
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
  /** A stored status, or OVERDUE (derived). */
  readonly status?: InvoiceStatus | "OVERDUE";
  readonly kind?: InvoiceKind;
  readonly customerId?: string;
  readonly from?: string;
  readonly to?: string;
  /** Today in Africa/Nairobi -- the cutoff for OVERDUE. */
  readonly today: string;
  readonly limit: number;
  /** Position after which to continue: the last row of the previous page. */
  readonly after?: { readonly createdAt: string; readonly id: string };
}

const OVERDUE_SQL = (todayParam: string) =>
  `(i.kind = 'INVOICE' AND i.status IN ('ISSUED', 'PART_PAID') AND i.due_date < ${todayParam})`;

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

    if (filters.status === "OVERDUE") {
      where.push(OVERDUE_SQL(`${add(filters.today)}::date`));
    } else if (filters.status !== undefined) {
      where.push(`i.status = ${add(filters.status)}`);
      if (filters.status === "ISSUED" || filters.status === "PART_PAID") {
        where.push(`NOT ${OVERDUE_SQL(`${add(filters.today)}::date`)}`);
      }
    }
    if (filters.kind !== undefined) {
      where.push(`i.kind = ${add(filters.kind)}`);
    }
    if (filters.customerId !== undefined) {
      where.push(`i.customer_id = ${add(filters.customerId)}`);
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
      `SELECT i.*, c.name AS customer_name, i.created_at::text AS sort_key
         FROM invoices i
         JOIN customers c ON c.id = i.customer_id
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT ${add(filters.limit + 1)}`,
      params,
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
  readonly method: InvoicePaymentMethod | "CREDIT_NOTE";
  readonly amountMinor: number;
  readonly unappliedMinor: number;
  readonly date: string;
  readonly receivedAccountId?: string;
  readonly reference?: string;
  readonly journalId: string;
  readonly paymentId?: string;
  readonly creditNoteId?: string;
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
        received_account_id, reference, journal_id, payment_id, credit_note_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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

export interface OpenInvoiceRow {
  readonly id: string;
  readonly number: string;
  readonly customer_id: string;
  readonly customer_name: string;
  readonly issue_date: string;
  readonly due_date: string | null;
  readonly total_minor: string;
  /** What was still owed at the as-of date. */
  readonly open_minor: string;
}

/**
 * Invoices that had something left to pay at the end of `asOf`: issued on
 * or before it, not yet cancelled then, and not covered by payments and
 * credit notes dated on or before it. Reconstructed from allocation dates,
 * so a past as-of date gives the past picture.
 */
export async function listOpenInvoicesAsOf(
  tenantId: string,
  asOf: string,
  customerId?: string,
): Promise<OpenInvoiceRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const params: unknown[] = [asOf];
    if (customerId !== undefined) {
      params.push(customerId);
    }
    const result = await client.query<OpenInvoiceRow>(
      `SELECT * FROM (
         SELECT i.id, i.number, i.customer_id, c.name AS customer_name, i.issue_date, i.due_date, i.total_minor,
                (i.total_minor - COALESCE(
                   (SELECT SUM(a.amount_minor) FROM invoice_allocations a WHERE a.invoice_id = i.id AND a.date <= $1::date),
                   0))::text AS open_minor
           FROM invoices i
           JOIN customers c ON c.id = i.customer_id
          WHERE i.kind = 'INVOICE'
            AND i.status <> 'DRAFT'
            AND i.issue_date <= $1::date
            AND (i.status <> 'CANCELLED' OR (i.cancelled_at AT TIME ZONE 'Africa/Nairobi')::date > $1::date)
            ${customerId !== undefined ? "AND i.customer_id = $2" : ""}
       ) open
       WHERE open.open_minor::bigint > 0
       ORDER BY open.due_date NULLS FIRST, open.issue_date, open.number`,
      params,
    );
    return result.rows;
  });
}
