/**
 * Tenants service -- the caller's own business: name, base currency, VAT
 * registration and plan tier. Clients use plan_tier to decide what to
 * offer (FR-MIC-08): STARTER is the micro-trader tier.
 */

import { DomainError, type SystemAccountKey } from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import * as accountsService from "../accounts/service.js";
import * as rolesService from "../roles/service.js";
import * as usersService from "../users/service.js";
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

/** What GET/PATCH /tenant return: the tenant plus the id of the account
 * set for each purpose (null if none), so clients never find accounts by code. */
export interface TenantView extends TenantRow {
  readonly system_accounts: Record<SystemAccountKey, string | null>;
}

export async function toTenantView(tenant: TenantRow): Promise<TenantView> {
  return { ...tenant, system_accounts: await accountsService.systemAccountIds(tenant.id) };
}

/**
 * Changes the business's own settings. Turning manual journal approval on
 * needs at least two active users who can approve: nobody may approve their
 * own journal (FR-RBAC-03), so with one approver every journal would wait
 * forever.
 */
export async function updateTenant(
  tenantId: string,
  input: repository.UpdateTenantInput,
  audit: AuditContext,
): Promise<TenantRow> {
  if (input.manualJournalApprovalThresholdMinor !== undefined && input.manualJournalApprovalThresholdMinor !== null) {
    const users = await usersService.listUsers(tenantId);
    let approvers = 0;
    for (const user of users.filter((u) => u.status === "ACTIVE")) {
      if ((await rolesService.effectivePermissions(tenantId, user.id)).has("journals:approve")) {
        approvers++;
      }
    }
    if (approvers < 2) {
      throw new DomainError(
        "NOT_ENOUGH_APPROVERS",
        `Journal approval needs at least two active users who can approve journals (Owner or Accountant); this business has ${approvers}`,
      );
    }
  }
  return repository.updateTenant(tenantId, input, audit);
}
