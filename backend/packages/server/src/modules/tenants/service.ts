/**
 * Tenants service -- the caller's own business: name, base currency, VAT
 * registration and plan tier. Clients use plan_tier to decide what to
 * offer (FR-MIC-08): STARTER is the micro-trader tier.
 */

import * as repository from "./repository.js";
import type { TenantRow } from "./repository.js";

export async function getTenant(tenantId: string): Promise<TenantRow> {
  const tenant = await repository.getTenant(tenantId);
  if (!tenant) {
    // The caller's identity resolved to this tenant, so it must exist.
    throw new Error(`Tenant ${tenantId} not found for an authenticated user`);
  }
  return tenant;
}
