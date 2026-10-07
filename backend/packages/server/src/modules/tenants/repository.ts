/**
 * Tenants repository -- read-only. Tenants are created by the onboarding
 * module; this exposes the caller's own tenant to clients.
 */

import { readAsTenant, recordAuditLog, withTenant, type AuditContext } from "@jibuks/db";

export interface TenantRow {
  readonly id: string;
  readonly name: string;
  readonly type: "BUSINESS" | "NGO" | "HOUSEHOLD";
  readonly base_currency: string;
  readonly accounting_framework: "IFRS" | "GAAP" | "IPSAS";
  readonly plan_tier: "STARTER" | "GROWTH" | "ENTERPRISE";
  readonly status: "ACTIVE" | "SUSPENDED";
  readonly vat_registered: boolean;
  /** The business's own tax PIN (e.g. KRA PIN); null if not set. */
  readonly tax_identifier: string | null;
  readonly created_at: string;
}

const COLUMNS =
  "id, name, type, base_currency, accounting_framework, plan_tier, status, vat_registered, tax_identifier, created_at";

export async function getTenant(tenantId: string): Promise<TenantRow | null> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<TenantRow>(
      `SELECT ${COLUMNS} FROM tenants WHERE id = $1`,
      [tenantId],
    );
    return result.rows[0] ?? null;
  });
}

export async function updateTenant(
  tenantId: string,
  input: { readonly taxIdentifier?: string | null },
  audit: AuditContext,
): Promise<TenantRow> {
  return withTenant(tenantId, async (client) => {
    const before = await client.query<TenantRow>(`SELECT ${COLUMNS} FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);
    const result = await client.query<TenantRow>(
      `UPDATE tenants
          SET tax_identifier = CASE WHEN $2 THEN $3 ELSE tax_identifier END
        WHERE id = $1
       RETURNING ${COLUMNS}`,
      [tenantId, input.taxIdentifier !== undefined, input.taxIdentifier ?? null],
    );
    const tenant = result.rows[0]!;
    await recordAuditLog(client, {
      tenantId,
      action: "UPDATE",
      entityType: "tenant",
      entityId: tenantId,
      beforeState: before.rows[0],
      afterState: tenant,
      context: audit,
    });
    return tenant;
  });
}
