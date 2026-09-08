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
}

export async function createCustomer(input: CreateCustomerInput, audit: AuditContext): Promise<CustomerRow> {
  return withTenant(input.tenantId, async (client) => {
    const id = randomUUID();
    const result = await client.query<CustomerRow>(
      `INSERT INTO customers (id, tenant_id, name, phone, email, address, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        id,
        input.tenantId,
        input.name,
        input.phone ?? null,
        input.email ?? null,
        input.address ?? null,
        input.tags ?? [],
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

export async function listCustomers(tenantId: string, asOf?: string): Promise<CustomerWithBalanceRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const params: unknown[] = [];
    let asOfParamIndex: number | null = null;
    if (asOf) {
      params.push(asOf);
      asOfParamIndex = params.length;
    }

    const result = await client.query<CustomerWithBalanceRow>(
      `SELECT c.*, ${BALANCE_EXPR}
       FROM customers c
       ${balanceJoin(asOfParamIndex)}
       GROUP BY c.id
       ORDER BY c.name ASC`,
      params,
    );
    return result.rows;
  });
}

export async function getCustomerById(
  tenantId: string,
  customerId: string,
  asOf?: string,
): Promise<CustomerWithBalanceRow | null> {
  return readAsTenant(tenantId, async (client) => {
    const params: unknown[] = [customerId];
    let asOfParamIndex: number | null = null;
    if (asOf) {
      params.push(asOf);
      asOfParamIndex = params.length;
    }

    const result = await client.query<CustomerWithBalanceRow>(
      `SELECT c.*, ${BALANCE_EXPR}
       FROM customers c
       ${balanceJoin(asOfParamIndex)}
       WHERE c.id = $1
       GROUP BY c.id`,
      params,
    );
    return result.rows[0] ?? null;
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
