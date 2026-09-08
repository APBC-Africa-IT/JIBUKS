/**
 * Suppliers repository.
 *
 * The ONLY file permitted to write raw SQL against the `suppliers` table
 * (AD-02: "a module MUST own its tables exclusively"). Every write goes
 * through recordAuditLog inside the SAME transaction, per FR-AUD-01.
 *
 * Mirrors customers/repository.ts, except a supplier's balance sits on the
 * credit side (money we owe them, AP-like) instead of the debit side.
 */

import { randomUUID } from "node:crypto";
import { recordAuditLog, withTenant, readAsTenant, type AuditContext } from "@jibuks/db";

export interface SupplierRow {
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

/** A SupplierRow plus its computed balance -- what GET /suppliers and GET
 * /suppliers/{id} return. Net of POSTED journal_lines tagged with this
 * supplier, hardcoded to the credit side (money owed to them is a credit
 * balance, the same as a LIABILITY account's natural side). bigint sum
 * comes back from pg as a string. */
export interface SupplierWithBalanceRow extends SupplierRow {
  readonly balance_minor: string;
}

/** Mirrors customers/repository.ts's balanceJoin, keyed on
 * journal_lines.supplier_id. Only POSTED journals count (FR-ACC-02). */
function balanceJoin(asOfParamIndex: number | null): string {
  const asOfClause = asOfParamIndex !== null ? ` AND j.date <= $${asOfParamIndex}` : "";
  return `
    LEFT JOIN journal_lines jl ON jl.supplier_id = s.id
    LEFT JOIN journals j ON j.id = jl.journal_id AND j.status = 'POSTED'${asOfClause}
  `;
}

const BALANCE_EXPR = `
  COALESCE(SUM(
    CASE WHEN j.id IS NULL THEN 0
         ELSE jl.credit_minor - jl.debit_minor
    END
  ), 0)::text AS balance_minor
`;

export interface CreateSupplierInput {
  readonly tenantId: string;
  readonly name: string;
  readonly phone?: string;
  readonly email?: string;
  readonly address?: string;
  readonly tags?: string[];
}

export async function createSupplier(input: CreateSupplierInput, audit: AuditContext): Promise<SupplierRow> {
  return withTenant(input.tenantId, async (client) => {
    const id = randomUUID();
    const result = await client.query<SupplierRow>(
      `INSERT INTO suppliers (id, tenant_id, name, phone, email, address, tags)
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

    const supplier = result.rows[0]!;

    await recordAuditLog(client, {
      tenantId: input.tenantId,
      action: "CREATE",
      entityType: "supplier",
      entityId: supplier.id,
      afterState: supplier,
      context: audit,
    });

    return supplier;
  });
}

export async function listSuppliers(tenantId: string, asOf?: string): Promise<SupplierWithBalanceRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const params: unknown[] = [];
    let asOfParamIndex: number | null = null;
    if (asOf) {
      params.push(asOf);
      asOfParamIndex = params.length;
    }

    const result = await client.query<SupplierWithBalanceRow>(
      `SELECT s.*, ${BALANCE_EXPR}
       FROM suppliers s
       ${balanceJoin(asOfParamIndex)}
       GROUP BY s.id
       ORDER BY s.name ASC`,
      params,
    );
    return result.rows;
  });
}

export async function getSupplierById(
  tenantId: string,
  supplierId: string,
  asOf?: string,
): Promise<SupplierWithBalanceRow | null> {
  return readAsTenant(tenantId, async (client) => {
    const params: unknown[] = [supplierId];
    let asOfParamIndex: number | null = null;
    if (asOf) {
      params.push(asOf);
      asOfParamIndex = params.length;
    }

    const result = await client.query<SupplierWithBalanceRow>(
      `SELECT s.*, ${BALANCE_EXPR}
       FROM suppliers s
       ${balanceJoin(asOfParamIndex)}
       WHERE s.id = $1
       GROUP BY s.id`,
      params,
    );
    return result.rows[0] ?? null;
  });
}

/** Suppliers are never deleted, only deactivated (same FR-COA-03 philosophy
 * applied to a name list -- history against a supplier must stay retrievable). */
export async function deactivateSupplier(
  tenantId: string,
  supplierId: string,
  audit: AuditContext,
): Promise<SupplierRow | null> {
  return withTenant(tenantId, async (client) => {
    const before = await client.query<SupplierRow>(`SELECT * FROM suppliers WHERE id = $1`, [supplierId]);
    if (before.rows.length === 0) {
      return null;
    }

    const result = await client.query<SupplierRow>(
      `UPDATE suppliers SET is_active = false WHERE id = $1 RETURNING *`,
      [supplierId],
    );
    const supplier = result.rows[0]!;

    await recordAuditLog(client, {
      tenantId,
      action: "UPDATE",
      entityType: "supplier",
      entityId: supplier.id,
      beforeState: before.rows[0],
      afterState: supplier,
      context: audit,
    });

    return supplier;
  });
}

export async function reactivateSupplier(
  tenantId: string,
  supplierId: string,
  audit: AuditContext,
): Promise<SupplierRow | null> {
  return withTenant(tenantId, async (client) => {
    const before = await client.query<SupplierRow>(`SELECT * FROM suppliers WHERE id = $1`, [supplierId]);
    if (before.rows.length === 0) {
      return null;
    }

    const result = await client.query<SupplierRow>(
      `UPDATE suppliers SET is_active = true WHERE id = $1 RETURNING *`,
      [supplierId],
    );
    const supplier = result.rows[0]!;

    await recordAuditLog(client, {
      tenantId,
      action: "UPDATE",
      entityType: "supplier",
      entityId: supplier.id,
      beforeState: before.rows[0],
      afterState: supplier,
      context: audit,
    });

    return supplier;
  });
}
