/**
 * Customer payments repository -- the only file that writes
 * customer_payments and payment_number_sequences (AD-02). Writes run inside
 * the service's transaction so the payment, its journal and its
 * allocations commit together, and are audited there (FR-AUD-01).
 */

import { randomUUID } from "node:crypto";
import { recordAuditLog, readAsTenant, type AuditContext } from "@jibuks/db";
import type { InvoicePaymentMethod } from "@jibuks/domain";
import type { TxClient } from "../invoices/service.js";

export interface CustomerPaymentRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly client_uuid: string;
  readonly number: string;
  readonly customer_id: string;
  readonly date: string;
  readonly currency: string;
  readonly amount_minor: string; // bigint
  readonly applied_minor: string;
  /** Customer credit still on the payment. */
  readonly unapplied_minor: string;
  /** Credit paid back to the customer (customer refunds). amount = applied + unapplied + refunded. */
  readonly refunded_minor: string;
  /** The receivable account the payment's credit was posted to; null if it never had any. */
  readonly credit_account_id: string | null;
  readonly method: InvoicePaymentMethod;
  readonly received_account_id: string | null;
  readonly reference: string | null;
  readonly memo: string | null;
  readonly journal_id: string;
  readonly payment_id: string | null;
  readonly created_by: string;
  readonly created_at: string;
}

/** A CustomerPaymentRow plus its customer's current name. */
export interface CustomerPaymentListRow extends CustomerPaymentRow {
  readonly customer_name: string;
}

/** One invoice a payment was applied to. */
export interface PaymentAllocationRow {
  readonly customer_payment_id: string;
  readonly invoice_id: string;
  readonly invoice_number: string;
  readonly amount_minor: string;
  readonly date: string;
}

const COLUMNS = `p.id, p.tenant_id, p.client_uuid, p.number, p.customer_id, p.date::text AS date, p.currency, p.amount_minor,
  p.applied_minor, p.unapplied_minor, p.refunded_minor, p.credit_account_id, p.method, p.received_account_id, p.reference, p.memo, p.journal_id, p.payment_id,
  p.created_by, p.created_at, c.name AS customer_name`;

const SELECT_WITH_CUSTOMER = `SELECT ${COLUMNS} FROM customer_payments p JOIN customers c ON c.id = p.customer_id`;

/** The tenant's next PMT- number. Gapless: the counter commits or rolls back with the payment. */
export async function nextNumber(client: TxClient, tenantId: string): Promise<string> {
  const result = await client.query<{ last_value: number }>(
    `INSERT INTO payment_number_sequences (tenant_id, last_value) VALUES ($1, 1)
     ON CONFLICT (tenant_id) DO UPDATE SET last_value = payment_number_sequences.last_value + 1
     RETURNING last_value`,
    [tenantId],
  );
  return `PMT-${String(result.rows[0]!.last_value).padStart(6, "0")}`;
}

export interface InsertPaymentInput {
  readonly tenantId: string;
  readonly clientUuid: string;
  readonly number: string;
  readonly customerId: string;
  readonly date: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly appliedMinor: number;
  readonly method: InvoicePaymentMethod;
  readonly receivedAccountId: string;
  readonly reference: string | null;
  readonly memo: string | null;
  readonly journalId: string;
  readonly paymentId: string | null;
  readonly creditAccountId: string | null;
}

export async function insertPayment(client: TxClient, input: InsertPaymentInput, audit: AuditContext): Promise<CustomerPaymentRow> {
  const result = await client.query<CustomerPaymentRow>(
    `INSERT INTO customer_payments
       (id, tenant_id, client_uuid, number, customer_id, date, currency, amount_minor, applied_minor, unapplied_minor,
        method, received_account_id, reference, memo, journal_id, payment_id, credit_account_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING *`,
    [
      randomUUID(),
      input.tenantId,
      input.clientUuid,
      input.number,
      input.customerId,
      input.date,
      input.currency,
      input.amountMinor,
      input.appliedMinor,
      input.amountMinor - input.appliedMinor,
      input.method,
      input.receivedAccountId,
      input.reference,
      input.memo,
      input.journalId,
      input.paymentId,
      input.creditAccountId,
      audit.actorUserId,
    ],
  );
  const payment = result.rows[0]!;
  await recordAuditLog(client, {
    tenantId: input.tenantId,
    action: "CREATE",
    entityType: "customer_payment",
    entityId: payment.id,
    afterState: payment,
    context: audit,
  });
  return payment;
}

export async function getPayment(tenantId: string, id: string): Promise<CustomerPaymentListRow | null> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<CustomerPaymentListRow>(`${SELECT_WITH_CUSTOMER} WHERE p.id = $1`, [id]);
    return result.rows[0] ?? null;
  });
}

export async function findByPaymentId(tenantId: string, paymentId: string): Promise<CustomerPaymentListRow | null> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<CustomerPaymentListRow>(`${SELECT_WITH_CUSTOMER} WHERE p.payment_id = $1`, [paymentId]);
    return result.rows[0] ?? null;
  });
}

/** The invoices each payment was applied to: in the order applied, oldest due first within one transaction. */
export async function listAllocations(tenantId: string, paymentIds: readonly string[]): Promise<PaymentAllocationRow[]> {
  if (paymentIds.length === 0) {
    return [];
  }
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<PaymentAllocationRow>(
      `SELECT a.customer_payment_id, a.invoice_id, i.number AS invoice_number, a.amount_minor, a.date::text AS date
         FROM invoice_allocations a
         JOIN invoices i ON i.id = a.invoice_id
        WHERE a.customer_payment_id = ANY($1::uuid[]) AND a.amount_minor > 0
        ORDER BY a.created_at, COALESCE(i.due_date, i.issue_date), i.issue_date, i.created_at, i.id`,
      [paymentIds],
    );
    return result.rows;
  });
}

/** The payments whose journal is one of `journalIds` (the customer ledger names rows with these). */
export async function listByJournalIds(tenantId: string, journalIds: readonly string[]): Promise<CustomerPaymentListRow[]> {
  if (journalIds.length === 0) {
    return [];
  }
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<CustomerPaymentListRow>(`${SELECT_WITH_CUSTOMER} WHERE p.journal_id = ANY($1::uuid[])`, [
      journalIds,
    ]);
    return result.rows;
  });
}

export interface ListFilters {
  readonly customerId?: string | undefined;
  readonly method?: InvoicePaymentMethod | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly hasCredit?: boolean | undefined;
  readonly q?: string | undefined;
  readonly after?: { readonly createdAt: string; readonly id: string } | undefined;
  readonly limit: number;
}

/** Newest first; one row more than `limit` so the caller can tell whether there is another page. */
export async function listPayments(
  tenantId: string,
  filters: ListFilters,
): Promise<(CustomerPaymentListRow & { sort_key: string })[]> {
  return readAsTenant(tenantId, async (client) => {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [];
    if (filters.customerId !== undefined) where.push(`p.customer_id = ${add(filters.customerId)}`);
    if (filters.method !== undefined) where.push(`p.method = ${add(filters.method)}`);
    if (filters.from !== undefined) where.push(`p.date >= ${add(filters.from)}`);
    if (filters.to !== undefined) where.push(`p.date <= ${add(filters.to)}`);
    if (filters.hasCredit !== undefined) where.push(filters.hasCredit ? "p.unapplied_minor > 0" : "p.unapplied_minor = 0");
    if (filters.q !== undefined) {
      // Escape LIKE wildcards so "50%" searches for the text.
      const p = add(`%${filters.q.replace(/[\\%_]/g, "\\$&")}%`);
      where.push(`(c.name ILIKE ${p} OR p.number ILIKE ${p} OR p.reference ILIKE ${p})`);
    }
    if (filters.after !== undefined) {
      where.push(`(p.created_at, p.id) < (${add(filters.after.createdAt)}::timestamptz, ${add(filters.after.id)}::uuid)`);
    }
    const result = await client.query<CustomerPaymentListRow & { sort_key: string }>(
      `SELECT ${COLUMNS}, p.created_at::text AS sort_key
         FROM customer_payments p JOIN customers c ON c.id = p.customer_id
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ${add(filters.limit + 1)}`,
      params,
    );
    return result.rows;
  });
}

/** Locks a payment row for the rest of the transaction. */
export async function lockPayment(client: TxClient, id: string): Promise<CustomerPaymentRow | null> {
  const result = await client.query<CustomerPaymentRow>(`SELECT * FROM customer_payments WHERE id = $1 FOR UPDATE`, [id]);
  return result.rows[0] ?? null;
}

/**
 * Moves `amountMinor` of a locked payment's credit to applied (used on an
 * invoice) or refunded. The database refuses more than its unapplied_minor.
 */
export async function useCredit(
  client: TxClient,
  before: CustomerPaymentRow,
  amountMinor: number,
  use: "APPLIED" | "REFUNDED",
  audit: AuditContext,
): Promise<CustomerPaymentRow> {
  const column = use === "APPLIED" ? "applied_minor" : "refunded_minor";
  const result = await client.query<CustomerPaymentRow>(
    `UPDATE customer_payments SET unapplied_minor = unapplied_minor - $2, ${column} = ${column} + $2 WHERE id = $1 RETURNING *`,
    [before.id, amountMinor],
  );
  const payment = result.rows[0]!;
  await recordAuditLog(client, {
    tenantId: before.tenant_id,
    action: "UPDATE",
    entityType: "customer_payment",
    entityId: before.id,
    beforeState: before,
    afterState: payment,
    context: audit,
  });
  return payment;
}

/** The customer's payments with credit left on them, oldest first. */
export async function listWithCredit(tenantId: string, customerId: string): Promise<CustomerPaymentListRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<CustomerPaymentListRow>(
      `${SELECT_WITH_CUSTOMER} WHERE p.customer_id = $1 AND p.unapplied_minor > 0 ORDER BY p.date, p.created_at, p.id`,
      [customerId],
    );
    return result.rows;
  });
}
