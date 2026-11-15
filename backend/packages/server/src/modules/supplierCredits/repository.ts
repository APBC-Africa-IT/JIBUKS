/**
 * Supplier credits repository -- the only file that writes
 * supplier_refunds, supplier_refund_sources and
 * supplier_refund_number_sequences (AD-02). Writes run in the service's
 * transaction and are audited there.
 */

import { randomUUID } from "node:crypto";
import { recordAuditLog, readAsTenant, type AuditContext } from "@jibuks/db";
import type { SupplierPaymentMethod } from "@jibuks/domain";
import type { TxClient } from "../invoices/service.js";

export interface SupplierRefundRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly client_uuid: string;
  readonly number: string;
  readonly supplier_id: string;
  readonly date: string;
  readonly currency: string;
  readonly amount_minor: string; // bigint
  readonly method: SupplierPaymentMethod;
  /** The cash, bank or M-Pesa account the money went into. */
  readonly received_account_id: string;
  readonly reference: string | null;
  readonly memo: string | null;
  readonly journal_id: string;
  readonly created_by: string;
  readonly created_at: string;
}

export interface SupplierRefundListRow extends SupplierRefundRow {
  readonly supplier_name: string;
}

/** One credit a refund drew on: a debit note or a supplier payment. */
export interface SupplierRefundSourceRow {
  readonly refund_id: string;
  readonly debit_note_id: string | null;
  readonly supplier_payment_id: string | null;
  /** The debit note's or payment's number. */
  readonly number: string;
  readonly amount_minor: string;
}

const COLUMNS = `r.id, r.tenant_id, r.client_uuid, r.number, r.supplier_id, r.date, r.currency, r.amount_minor, r.method,
  r.received_account_id, r.reference, r.memo, r.journal_id, r.created_by, r.created_at, s.name AS supplier_name`;

const SELECT_WITH_SUPPLIER = `SELECT ${COLUMNS} FROM supplier_refunds r JOIN suppliers s ON s.id = r.supplier_id`;

/** The tenant's next SRF- number. Gapless: the counter commits or rolls back with the refund. */
export async function nextNumber(client: TxClient, tenantId: string): Promise<string> {
  const result = await client.query<{ last_value: number }>(
    `INSERT INTO supplier_refund_number_sequences (tenant_id, last_value) VALUES ($1, 1)
     ON CONFLICT (tenant_id) DO UPDATE SET last_value = supplier_refund_number_sequences.last_value + 1
     RETURNING last_value`,
    [tenantId],
  );
  return `SRF-${String(result.rows[0]!.last_value).padStart(6, "0")}`;
}

export interface InsertRefundInput {
  readonly tenantId: string;
  readonly clientUuid: string;
  readonly number: string;
  readonly supplierId: string;
  readonly date: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly method: SupplierPaymentMethod;
  readonly receivedAccountId: string;
  readonly reference: string | null;
  readonly memo: string | null;
  readonly journalId: string;
  readonly sources: readonly { readonly debitNoteId: string | null; readonly supplierPaymentId: string | null; readonly amountMinor: number }[];
}

export async function insertRefund(client: TxClient, input: InsertRefundInput, audit: AuditContext): Promise<SupplierRefundRow> {
  const id = randomUUID();
  const result = await client.query<SupplierRefundRow>(
    `INSERT INTO supplier_refunds
       (id, tenant_id, client_uuid, number, supplier_id, date, currency, amount_minor, method, received_account_id,
        reference, memo, journal_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      id,
      input.tenantId,
      input.clientUuid,
      input.number,
      input.supplierId,
      input.date,
      input.currency,
      input.amountMinor,
      input.method,
      input.receivedAccountId,
      input.reference,
      input.memo,
      input.journalId,
      audit.actorUserId,
    ],
  );
  for (const source of input.sources) {
    await client.query(
      `INSERT INTO supplier_refund_sources (id, tenant_id, refund_id, debit_note_id, supplier_payment_id, amount_minor)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), input.tenantId, id, source.debitNoteId, source.supplierPaymentId, source.amountMinor],
    );
  }
  const refund = result.rows[0]!;
  await recordAuditLog(client, {
    tenantId: input.tenantId,
    action: "CREATE",
    entityType: "supplier_refund",
    entityId: id,
    afterState: { ...refund, sources: input.sources },
    context: audit,
  });
  return refund;
}

export async function getRefund(tenantId: string, id: string): Promise<SupplierRefundListRow | null> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<SupplierRefundListRow>(`${SELECT_WITH_SUPPLIER} WHERE r.id = $1`, [id]);
    return result.rows[0] ?? null;
  });
}

export async function listSources(tenantId: string, refundIds: readonly string[]): Promise<SupplierRefundSourceRow[]> {
  if (refundIds.length === 0) {
    return [];
  }
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<SupplierRefundSourceRow>(
      `SELECT s.refund_id, s.debit_note_id, s.supplier_payment_id, COALESCE(i.number, p.number) AS number, s.amount_minor
         FROM supplier_refund_sources s
         LEFT JOIN invoices i ON i.id = s.debit_note_id
         LEFT JOIN supplier_payments p ON p.id = s.supplier_payment_id
        WHERE s.refund_id = ANY($1::uuid[])
        ORDER BY COALESCE(i.issue_date, p.date), s.id`,
      [refundIds],
    );
    return result.rows;
  });
}

/** The refunds posted by these journals (the supplier ledger names rows with these). */
export async function listByJournalIds(tenantId: string, journalIds: readonly string[]): Promise<SupplierRefundListRow[]> {
  if (journalIds.length === 0) {
    return [];
  }
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<SupplierRefundListRow>(`${SELECT_WITH_SUPPLIER} WHERE r.journal_id = ANY($1::uuid[])`, [
      journalIds,
    ]);
    return result.rows;
  });
}

export interface ListFilters {
  readonly supplierId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly after?: { readonly createdAt: string; readonly id: string } | undefined;
  readonly limit: number;
}

/** Newest first; one row more than `limit` so the caller can tell whether there is another page. */
export async function listRefunds(tenantId: string, filters: ListFilters): Promise<(SupplierRefundListRow & { sort_key: string })[]> {
  return readAsTenant(tenantId, async (client) => {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [];
    if (filters.supplierId !== undefined) where.push(`r.supplier_id = ${add(filters.supplierId)}`);
    if (filters.from !== undefined) where.push(`r.date >= ${add(filters.from)}`);
    if (filters.to !== undefined) where.push(`r.date <= ${add(filters.to)}`);
    if (filters.after !== undefined) {
      where.push(`(r.created_at, r.id) < (${add(filters.after.createdAt)}::timestamptz, ${add(filters.after.id)}::uuid)`);
    }
    const result = await client.query<SupplierRefundListRow & { sort_key: string }>(
      `SELECT ${COLUMNS}, r.created_at::text AS sort_key
         FROM supplier_refunds r JOIN suppliers s ON s.id = r.supplier_id
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${add(filters.limit + 1)}`,
      params,
    );
    return result.rows;
  });
}
