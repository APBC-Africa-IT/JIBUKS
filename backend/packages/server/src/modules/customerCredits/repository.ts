/**
 * Customer credits repository -- the only file that writes
 * customer_refunds, customer_refund_sources and refund_number_sequences
 * (AD-02). Writes run in the service's transaction and are audited there.
 */

import { randomUUID } from "node:crypto";
import { recordAuditLog, readAsTenant, type AuditContext } from "@jibuks/db";
import type { InvoicePaymentMethod } from "@jibuks/domain";
import type { TxClient } from "../invoices/service.js";

export interface RefundRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly client_uuid: string;
  readonly number: string;
  readonly customer_id: string;
  readonly date: string;
  readonly currency: string;
  readonly amount_minor: string; // bigint
  readonly method: InvoicePaymentMethod;
  readonly paid_from_account_id: string;
  readonly reference: string | null;
  readonly memo: string | null;
  readonly journal_id: string;
  readonly created_by: string;
  readonly created_at: string;
}

export interface RefundListRow extends RefundRow {
  readonly customer_name: string;
}

/** One credit a refund drew on: a credit note or a payment. */
export interface RefundSourceRow {
  readonly refund_id: string;
  readonly credit_note_id: string | null;
  readonly customer_payment_id: string | null;
  /** The credit note's or payment's number. */
  readonly number: string;
  readonly amount_minor: string;
}

const COLUMNS = `r.id, r.tenant_id, r.client_uuid, r.number, r.customer_id, r.date, r.currency, r.amount_minor, r.method,
  r.paid_from_account_id, r.reference, r.memo, r.journal_id, r.created_by, r.created_at, c.name AS customer_name`;

const SELECT_WITH_CUSTOMER = `SELECT ${COLUMNS} FROM customer_refunds r JOIN customers c ON c.id = r.customer_id`;

/** The tenant's next RF- number. Gapless: the counter commits or rolls back with the refund. */
export async function nextNumber(client: TxClient, tenantId: string): Promise<string> {
  const result = await client.query<{ last_value: number }>(
    `INSERT INTO refund_number_sequences (tenant_id, last_value) VALUES ($1, 1)
     ON CONFLICT (tenant_id) DO UPDATE SET last_value = refund_number_sequences.last_value + 1
     RETURNING last_value`,
    [tenantId],
  );
  return `RF-${String(result.rows[0]!.last_value).padStart(6, "0")}`;
}

export interface InsertRefundInput {
  readonly tenantId: string;
  readonly clientUuid: string;
  readonly number: string;
  readonly customerId: string;
  readonly date: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly method: InvoicePaymentMethod;
  readonly paidFromAccountId: string;
  readonly reference: string | null;
  readonly memo: string | null;
  readonly journalId: string;
  readonly sources: readonly { readonly creditNoteId: string | null; readonly customerPaymentId: string | null; readonly amountMinor: number }[];
}

export async function insertRefund(client: TxClient, input: InsertRefundInput, audit: AuditContext): Promise<RefundRow> {
  const id = randomUUID();
  const result = await client.query<RefundRow>(
    `INSERT INTO customer_refunds
       (id, tenant_id, client_uuid, number, customer_id, date, currency, amount_minor, method, paid_from_account_id,
        reference, memo, journal_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      id,
      input.tenantId,
      input.clientUuid,
      input.number,
      input.customerId,
      input.date,
      input.currency,
      input.amountMinor,
      input.method,
      input.paidFromAccountId,
      input.reference,
      input.memo,
      input.journalId,
      audit.actorUserId,
    ],
  );
  for (const source of input.sources) {
    await client.query(
      `INSERT INTO customer_refund_sources (id, tenant_id, refund_id, credit_note_id, customer_payment_id, amount_minor)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), input.tenantId, id, source.creditNoteId, source.customerPaymentId, source.amountMinor],
    );
  }
  const refund = result.rows[0]!;
  await recordAuditLog(client, {
    tenantId: input.tenantId,
    action: "CREATE",
    entityType: "customer_refund",
    entityId: id,
    afterState: { ...refund, sources: input.sources },
    context: audit,
  });
  return refund;
}

export async function getRefund(tenantId: string, id: string): Promise<RefundListRow | null> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<RefundListRow>(`${SELECT_WITH_CUSTOMER} WHERE r.id = $1`, [id]);
    return result.rows[0] ?? null;
  });
}

export async function listSources(tenantId: string, refundIds: readonly string[]): Promise<RefundSourceRow[]> {
  if (refundIds.length === 0) {
    return [];
  }
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<RefundSourceRow>(
      `SELECT s.refund_id, s.credit_note_id, s.customer_payment_id, COALESCE(i.number, p.number) AS number, s.amount_minor
         FROM customer_refund_sources s
         LEFT JOIN invoices i ON i.id = s.credit_note_id
         LEFT JOIN customer_payments p ON p.id = s.customer_payment_id
        WHERE s.refund_id = ANY($1::uuid[])
        ORDER BY COALESCE(i.issue_date, p.date), s.id`,
      [refundIds],
    );
    return result.rows;
  });
}

/** The refunds posted by these journals (the customer ledger names rows with these). */
export async function listByJournalIds(tenantId: string, journalIds: readonly string[]): Promise<RefundListRow[]> {
  if (journalIds.length === 0) {
    return [];
  }
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<RefundListRow>(`${SELECT_WITH_CUSTOMER} WHERE r.journal_id = ANY($1::uuid[])`, [journalIds]);
    return result.rows;
  });
}

export interface ListFilters {
  readonly customerId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly after?: { readonly createdAt: string; readonly id: string } | undefined;
  readonly limit: number;
}

/** Newest first; one row more than `limit` so the caller can tell whether there is another page. */
export async function listRefunds(tenantId: string, filters: ListFilters): Promise<(RefundListRow & { sort_key: string })[]> {
  return readAsTenant(tenantId, async (client) => {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [];
    if (filters.customerId !== undefined) where.push(`r.customer_id = ${add(filters.customerId)}`);
    if (filters.from !== undefined) where.push(`r.date >= ${add(filters.from)}`);
    if (filters.to !== undefined) where.push(`r.date <= ${add(filters.to)}`);
    if (filters.after !== undefined) {
      where.push(`(r.created_at, r.id) < (${add(filters.after.createdAt)}::timestamptz, ${add(filters.after.id)}::uuid)`);
    }
    const result = await client.query<RefundListRow & { sort_key: string }>(
      `SELECT ${COLUMNS}, r.created_at::text AS sort_key
         FROM customer_refunds r JOIN customers c ON c.id = r.customer_id
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${add(filters.limit + 1)}`,
      params,
    );
    return result.rows;
  });
}
