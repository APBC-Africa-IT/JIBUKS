/**
 * Tenants repository -- read-only. Tenants are created by the onboarding
 * module; this exposes the caller's own tenant to clients.
 */

import { readAsTenant } from "@jibuks/db";

export interface TenantRow {
  readonly id: string;
  readonly name: string;
  readonly type: "BUSINESS" | "NGO" | "HOUSEHOLD";
  readonly base_currency: string;
  readonly accounting_framework: "IFRS" | "GAAP" | "IPSAS";
  readonly plan_tier: "STARTER" | "GROWTH" | "ENTERPRISE";
  readonly status: "ACTIVE" | "SUSPENDED";
  readonly vat_registered: boolean;
  readonly created_at: string;
}

export async function getTenant(tenantId: string): Promise<TenantRow | null> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<TenantRow>(
      `SELECT id, name, type, base_currency, accounting_framework, plan_tier, status, vat_registered, created_at
         FROM tenants WHERE id = $1`,
      [tenantId],
    );
    return result.rows[0] ?? null;
  });
}
