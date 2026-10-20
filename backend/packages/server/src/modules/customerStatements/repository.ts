/**
 * Customer statements repository -- the only file that writes
 * customer_statements and statement_number_sequences (AD-02). Every write
 * is audited in the same transaction (FR-AUD-01).
 */

import { randomUUID } from "node:crypto";
import { recordAuditLog, readAsTenant, withTenant, type AuditContext } from "@jibuks/db";

export interface StatementRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly client_uuid: string;
  readonly number: string;
  readonly customer_id: string;
  readonly period_from: string;
  readonly period_to: string;
  readonly currency: string | null;
  readonly opening_balance_minor: string; // bigint
  readonly total_debit_minor: string;
  readonly total_credit_minor: string;
  readonly closing_balance_minor: string;
  readonly transactions: unknown[];
  readonly aging: Record<string, string>;
  readonly message: string | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly sent_at: string | null;
  readonly sent_by: string | null;
}

/** A StatementRow plus its customer's current name. */
export interface StatementListRow extends StatementRow {
  readonly customer_name: string;
}

/** Dates as plain YYYY-MM-DD text, like the rest of the API. */
const COLUMNS = `s.id, s.tenant_id, s.client_uuid, s.number, s.customer_id, s.period_from::text AS period_from,
  s.period_to::text AS period_to, s.currency, s.opening_balance_minor, s.total_debit_minor, s.total_credit_minor,
  s.closing_balance_minor, s.transactions, s.aging, s.message, s.created_by, s.created_at, s.sent_at, s.sent_by,
  c.name AS customer_name`;

const SELECT_WITH_CUSTOMER = `SELECT ${COLUMNS} FROM customer_statements s JOIN customers c ON c.id = s.customer_id`;

export interface InsertStatementInput {
  readonly tenantId: string;
  readonly clientUuid: string;
  readonly customerId: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly currency: string | null;
  readonly openingBalanceMinor: string;
  readonly totalDebitMinor: string;
  readonly totalCreditMinor: string;
  readonly closingBalanceMinor: string;
  readonly transactions: readonly unknown[];
  readonly aging: Readonly<Record<string, string>>;
  readonly message: string | null;
}

/** Inserts a statement with the tenant's next ST- number (gapless: the counter and the row commit together). */
export async function insertStatement(input: InsertStatementInput, audit: AuditContext): Promise<StatementListRow> {
  return withTenant(input.tenantId, async (client) => {
    const sequence = await client.query<{ last_value: number }>(
      `INSERT INTO statement_number_sequences (tenant_id, last_value) VALUES ($1, 1)
       ON CONFLICT (tenant_id) DO UPDATE SET last_value = statement_number_sequences.last_value + 1
       RETURNING last_value`,
      [input.tenantId],
    );
    const number = `ST-${String(sequence.rows[0]!.last_value).padStart(6, "0")}`;
    const id = randomUUID();
    await client.query(
      `INSERT INTO customer_statements
         (id, tenant_id, client_uuid, number, customer_id, period_from, period_to, currency, opening_balance_minor,
          total_debit_minor, total_credit_minor, closing_balance_minor, transactions, aging, message, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        id,
        input.tenantId,
        input.clientUuid,
        number,
        input.customerId,
        input.periodFrom,
        input.periodTo,
        input.currency,
        input.openingBalanceMinor,
        input.totalDebitMinor,
        input.totalCreditMinor,
        input.closingBalanceMinor,
        JSON.stringify(input.transactions),
        JSON.stringify(input.aging),
        input.message,
        audit.actorUserId,
      ],
    );
    const row = (await client.query<StatementListRow>(`${SELECT_WITH_CUSTOMER} WHERE s.id = $1`, [id])).rows[0]!;

    await recordAuditLog(client, {
      tenantId: input.tenantId,
      action: "CREATE",
      entityType: "customer_statement",
      entityId: id,
      // The transaction rows are a copy of the ledger; the totals identify the snapshot.
      afterState: { ...row, transactions: undefined },
      context: audit,
    });
    return row;
  });
}

export async function getStatement(tenantId: string, id: string): Promise<StatementListRow | null> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<StatementListRow>(`${SELECT_WITH_CUSTOMER} WHERE s.id = $1`, [id]);
    return result.rows[0] ?? null;
  });
}

export interface ListFilters {
  readonly customerId?: string | undefined;
  readonly sent?: boolean | undefined;
  readonly q?: string | undefined;
  readonly after?: { readonly createdAt: string; readonly id: string } | undefined;
  readonly limit: number;
}

/** Newest first; one row more than `limit` so the caller can tell whether there is another page. */
export async function listStatements(tenantId: string, filters: ListFilters): Promise<(StatementListRow & { sort_key: string })[]> {
  return readAsTenant(tenantId, async (client) => {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [];
    if (filters.customerId !== undefined) {
      where.push(`s.customer_id = ${add(filters.customerId)}`);
    }
    if (filters.sent !== undefined) {
      where.push(filters.sent ? "s.sent_at IS NOT NULL" : "s.sent_at IS NULL");
    }
    if (filters.q !== undefined) {
      // Escape LIKE wildcards so "50%" searches for the text.
      const p = add(`%${filters.q.replace(/[\\%_]/g, "\\$&")}%`);
      where.push(`(c.name ILIKE ${p} OR s.number ILIKE ${p})`);
    }
    if (filters.after !== undefined) {
      where.push(`(s.created_at, s.id) < (${add(filters.after.createdAt)}::timestamptz, ${add(filters.after.id)}::uuid)`);
    }
    const result = await client.query<StatementListRow & { sort_key: string }>(
      `${SELECT_WITH_CUSTOMER.replace(" FROM", ", s.created_at::text AS sort_key FROM")}
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT ${add(filters.limit + 1)}`,
      params,
    );
    return result.rows;
  });
}

/** Marks a statement sent. Only the first mark counts: one already sent is returned unchanged. */
export async function markSent(tenantId: string, id: string, audit: AuditContext): Promise<StatementListRow | null> {
  return withTenant(tenantId, async (client) => {
    const before = await client.query<StatementListRow>(`${SELECT_WITH_CUSTOMER} WHERE s.id = $1 FOR UPDATE OF s`, [id]);
    const existing = before.rows[0];
    if (!existing || existing.sent_at !== null) {
      return existing ?? null;
    }
    await client.query(`UPDATE customer_statements SET sent_at = now(), sent_by = $2 WHERE id = $1`, [id, audit.actorUserId]);
    const row = (await client.query<StatementListRow>(`${SELECT_WITH_CUSTOMER} WHERE s.id = $1`, [id])).rows[0]!;
    await recordAuditLog(client, {
      tenantId,
      action: "UPDATE",
      entityType: "customer_statement",
      entityId: id,
      beforeState: { sent_at: null, sent_by: null },
      afterState: { sent_at: row.sent_at, sent_by: row.sent_by },
      context: audit,
    });
    return row;
  });
}
