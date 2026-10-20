/**
 * Customers repository.
 *
 * The ONLY file permitted to write raw SQL against the `customers` table
 * (AD-02: "a module MUST own its tables exclusively"). Every write goes
 * through recordAuditLog inside the SAME transaction, per FR-AUD-01.
 *
 * Deliberately separate from accounts/repository.ts even though the shape
 * rhymes closely -- a customer is a name list entry, not a chart-of-accounts
 * row (see the migration's doc comment for why).
 */

import { randomUUID } from "node:crypto";
import { DomainError } from "@jibuks/domain";
import { recordAuditLog, withTenant, readAsTenant, type AuditContext } from "@jibuks/db";

export interface CustomerRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly is_active: boolean;
  readonly tags: string[];
  readonly tax_identifier: string | null;
  readonly payment_terms_days: number | null;
  /** Null means the tenant's base currency. */
  readonly currency: string | null;
  /** Integer minor units in the customer's currency, as a string (bigint); null = no limit. */
  readonly credit_limit_minor: string | null;
  readonly created_at: string;
}

/** A CustomerRow plus its computed balance -- what GET /customers and GET
 * /customers/{id} return. Net of POSTED journal_lines tagged with this
 * customer, hardcoded to the debit side (a customer owing money is a
 * debit balance, the same as an ASSET account's natural side) -- unlike
 * accounts, a customer has no `type` to branch on. bigint sum comes back
 * from pg as a string. */
export interface CustomerWithBalanceRow extends CustomerRow {
  readonly balance_minor: string;
}

/** Mirrors accounts/repository.ts's balanceJoin/BALANCE_EXPR, but keyed on
 * journal_lines.customer_id instead of .account_id, and with a fixed
 * natural side instead of branching on account type. Only POSTED journals
 * count (FR-ACC-02) -- j.id IS NULL covers "no lines at all" and "lines
 * whose journal didn't match the POSTED/asOf filter" alike, contributing 0. */
function balanceJoin(asOfParamIndex: number | null): string {
  const asOfClause = asOfParamIndex !== null ? ` AND j.date <= $${asOfParamIndex}` : "";
  return `
    LEFT JOIN journal_lines jl ON jl.customer_id = c.id
    LEFT JOIN journals j ON j.id = jl.journal_id AND j.status = 'POSTED'${asOfClause}
  `;
}

const BALANCE_EXPR = `
  COALESCE(SUM(
    CASE WHEN j.id IS NULL THEN 0
         ELSE jl.debit_minor - jl.credit_minor
    END
  ), 0)::text AS balance_minor
`;

export interface CreateCustomerInput {
  readonly tenantId: string;
  readonly name: string;
  readonly phone?: string;
  readonly email?: string;
  readonly address?: string;
  readonly tags?: string[];
  readonly taxIdentifier?: string;
  readonly paymentTermsDays?: number;
  readonly currency?: string;
  readonly creditLimitMinor?: number;
}

export async function createCustomer(input: CreateCustomerInput, audit: AuditContext): Promise<CustomerRow> {
  return withTenant(input.tenantId, async (client) => {
    const id = randomUUID();
    const result = await client.query<CustomerRow>(
      `INSERT INTO customers (id, tenant_id, name, phone, email, address, tags, tax_identifier, payment_terms_days, currency, credit_limit_minor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        id,
        input.tenantId,
        input.name,
        input.phone ?? null,
        input.email ?? null,
        input.address ?? null,
        input.tags ?? [],
        input.taxIdentifier ?? null,
        input.paymentTermsDays ?? null,
        input.currency ?? null,
        input.creditLimitMinor ?? null,
      ],
    );

    const customer = result.rows[0]!;

    await recordAuditLog(client, {
      tenantId: input.tenantId,
      action: "CREATE",
      entityType: "customer",
      entityId: customer.id,
      afterState: customer,
      context: audit,
    });

    return customer;
  });
}

/** The customer's most recent POSTED journal -- what the list's "last
 * activity" line is built from (customerLedger names it). Same as-of cutoff
 * as the balance. */
function lastActivityJoin(asOfParamIndex: number | null): string {
  const asOfClause = asOfParamIndex !== null ? ` AND j.date <= $${asOfParamIndex}` : "";
  return `
    LEFT JOIN LATERAL (
      SELECT j.id AS last_activity_journal_id, j.date::text AS last_activity_date, j.source AS last_activity_source
      FROM journal_lines jl
      JOIN journals j ON j.id = jl.journal_id AND j.status = 'POSTED'${asOfClause}
      WHERE jl.customer_id = base.id
      ORDER BY j.date DESC, j.created_at DESC, j.id DESC
      LIMIT 1
    ) la ON true
  `;
}

/** A CustomerWithBalanceRow plus the id, date and source of its latest posted journal (all null if none). */
export interface CustomerWithActivityRow extends CustomerWithBalanceRow {
  readonly last_activity_journal_id: string | null;
  readonly last_activity_date: string | null;
  readonly last_activity_source: string | null;
}

export interface ListCustomersFilters {
  readonly asOf?: string | undefined;
  /** Case-insensitive match on name, phone or email. */
  readonly q?: string | undefined;
}

export async function listCustomers(tenantId: string, filters: ListCustomersFilters = {}): Promise<CustomerWithActivityRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const params: unknown[] = [];
    let asOfParamIndex: number | null = null;
    if (filters.asOf) {
      params.push(filters.asOf);
      asOfParamIndex = params.length;
    }
    let where = "";
    if (filters.q) {
      // Escape LIKE wildcards so "50%" searches for the text.
      params.push(`%${filters.q.replace(/[\\%_]/g, "\\$&")}%`);
      const p = `$${params.length}`;
      where = `WHERE c.name ILIKE ${p} OR c.phone ILIKE ${p} OR c.email ILIKE ${p}`;
    }

    const result = await client.query<CustomerWithActivityRow>(
      `SELECT base.*, la.*
       FROM (
         SELECT c.*, ${BALANCE_EXPR}
         FROM customers c
         ${balanceJoin(asOfParamIndex)}
         ${where}
         GROUP BY c.id
       ) base
       ${lastActivityJoin(asOfParamIndex)}
       ORDER BY base.name ASC`,
      params,
    );
    return result.rows;
  });
}

export async function getCustomerById(
  tenantId: string,
  customerId: string,
  asOf?: string,
): Promise<CustomerWithActivityRow | null> {
  return readAsTenant(tenantId, async (client) => {
    const params: unknown[] = [customerId];
    let asOfParamIndex: number | null = null;
    if (asOf) {
      params.push(asOf);
      asOfParamIndex = params.length;
    }

    const result = await client.query<CustomerWithActivityRow>(
      `SELECT base.*, la.*
       FROM (
         SELECT c.*, ${BALANCE_EXPR}
         FROM customers c
         ${balanceJoin(asOfParamIndex)}
         WHERE c.id = $1
         GROUP BY c.id
       ) base
       ${lastActivityJoin(asOfParamIndex)}`,
      params,
    );
    return result.rows[0] ?? null;
  });
}

/** One POSTED journal's net effect on a customer -- a row of their ledger. */
export interface CustomerLedgerJournalRow {
  readonly journal_id: string;
  readonly date: string;
  readonly journal_number: string | null;
  readonly reference: string | null;
  readonly description: string;
  readonly source: string;
  readonly debit_minor: string; // bigint
  readonly credit_minor: string;
}

/** Every POSTED journal tagged with this customer in [from, to], oldest
 * first, its customer-tagged lines summed (a journal normally has one). */
export async function listLedgerJournals(
  tenantId: string,
  customerId: string,
  from?: string,
  to?: string,
): Promise<CustomerLedgerJournalRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const params: unknown[] = [customerId];
    const where = ["jl.customer_id = $1"];
    if (from) {
      params.push(from);
      where.push(`j.date >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      where.push(`j.date <= $${params.length}`);
    }
    const result = await client.query<CustomerLedgerJournalRow>(
      `SELECT j.id AS journal_id, j.date::text AS date, j.number AS journal_number, j.reference, j.description, j.source,
              SUM(jl.debit_minor)::text AS debit_minor, SUM(jl.credit_minor)::text AS credit_minor
       FROM journal_lines jl
       JOIN journals j ON j.id = jl.journal_id AND j.status = 'POSTED'
       WHERE ${where.join(" AND ")}
       GROUP BY j.id
       ORDER BY j.date, j.created_at, j.id`,
      params,
    );
    return result.rows;
  });
}

/** The customer's balance from POSTED journals dated before `date`. */
export async function balanceBefore(tenantId: string, customerId: string, date: string): Promise<number> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<{ balance_minor: string }>(
      `SELECT COALESCE(SUM(jl.debit_minor - jl.credit_minor), 0)::text AS balance_minor
       FROM journal_lines jl
       JOIN journals j ON j.id = jl.journal_id AND j.status = 'POSTED'
       WHERE jl.customer_id = $1 AND j.date < $2`,
      [customerId, date],
    );
    return Number(result.rows[0]!.balance_minor);
  });
}

/** Customers are never deleted, only deactivated (same FR-COA-03 philosophy
 * applied to a name list -- history against a customer must stay retrievable). */
export async function deactivateCustomer(
  tenantId: string,
  customerId: string,
  audit: AuditContext,
): Promise<CustomerRow | null> {
  return withTenant(tenantId, async (client) => {
    const before = await client.query<CustomerRow>(`SELECT * FROM customers WHERE id = $1`, [customerId]);
    if (before.rows.length === 0) {
      return null;
    }

    const result = await client.query<CustomerRow>(
      `UPDATE customers SET is_active = false WHERE id = $1 RETURNING *`,
      [customerId],
    );
    const customer = result.rows[0]!;

    await recordAuditLog(client, {
      tenantId,
      action: "UPDATE",
      entityType: "customer",
      entityId: customer.id,
      beforeState: before.rows[0],
      afterState: customer,
      context: audit,
    });

    return customer;
  });
}

export async function reactivateCustomer(
  tenantId: string,
  customerId: string,
  audit: AuditContext,
): Promise<CustomerRow | null> {
  return withTenant(tenantId, async (client) => {
    const before = await client.query<CustomerRow>(`SELECT * FROM customers WHERE id = $1`, [customerId]);
    if (before.rows.length === 0) {
      return null;
    }

    const result = await client.query<CustomerRow>(
      `UPDATE customers SET is_active = true WHERE id = $1 RETURNING *`,
      [customerId],
    );
    const customer = result.rows[0]!;

    await recordAuditLog(client, {
      tenantId,
      action: "UPDATE",
      entityType: "customer",
      entityId: customer.id,
      beforeState: before.rows[0],
      afterState: customer,
      context: audit,
    });

    return customer;
  });
}

export interface UpdateCustomerInput {
  readonly name?: string | undefined;
  readonly phone?: string | null | undefined;
  readonly email?: string | null | undefined;
  readonly address?: string | null | undefined;
  readonly tags?: string[] | undefined;
  readonly taxIdentifier?: string | null | undefined;
  readonly paymentTermsDays?: number | null | undefined;
  readonly currency?: string | null | undefined;
  readonly creditLimitMinor?: number | null | undefined;
}

const UPDATABLE_COLUMNS: Readonly<Record<keyof UpdateCustomerInput, string>> = {
  name: "name",
  phone: "phone",
  email: "email",
  address: "address",
  tags: "tags",
  taxIdentifier: "tax_identifier",
  paymentTermsDays: "payment_terms_days",
  currency: "currency",
  creditLimitMinor: "credit_limit_minor",
};

/**
 * Applies only the fields present in `input` (null clears a column).
 * Currency can't change once any journal line references this customer --
 * their balance and credit limit would silently change meaning.
 */
export async function updateCustomer(
  tenantId: string,
  customerId: string,
  input: UpdateCustomerInput,
  audit: AuditContext,
): Promise<CustomerRow | null> {
  return withTenant(tenantId, async (client) => {
    const before = await client.query<CustomerRow>(`SELECT * FROM customers WHERE id = $1 FOR UPDATE`, [customerId]);
    const existing = before.rows[0];
    if (!existing) {
      return null;
    }

    if (input.currency !== undefined && input.currency !== existing.currency) {
      const used = await client.query(`SELECT 1 FROM journal_lines WHERE customer_id = $1 LIMIT 1`, [customerId]);
      if (used.rows.length > 0) {
        throw new DomainError(
          "PARTY_CURRENCY_LOCKED",
          `Customer ${customerId} already has transactions; its currency can no longer be changed`,
        );
      }
    }

    const entries = (Object.keys(UPDATABLE_COLUMNS) as (keyof UpdateCustomerInput)[]).filter(
      (key) => input[key] !== undefined,
    );
    const assignments = entries.map((key, i) => `${UPDATABLE_COLUMNS[key]} = $${i + 2}`);
    const result = await client.query<CustomerRow>(
      `UPDATE customers SET ${assignments.join(", ")} WHERE id = $1 RETURNING *`,
      [customerId, ...entries.map((key) => input[key])],
    );
    const customer = result.rows[0]!;

    await recordAuditLog(client, {
      tenantId,
      action: "UPDATE",
      entityType: "customer",
      entityId: customer.id,
      beforeState: existing,
      afterState: customer,
      context: audit,
    });

    return customer;
  });
}
