/**
 * Onboarding repository.
 *
 * The ONLY place that creates a tenant and its first user together, in one
 * transaction. This is the legitimate bootstrap case flagged as a TODO in
 * users/repository.ts: a brand-new tenant has no existing authenticated
 * user to attribute the action to, so the new user is recorded as the
 * actor of their own (and their tenant's) creation -- correct specifically
 * because this is the one moment nobody else could possibly exist yet.
 */

import { randomUUID } from "node:crypto";
import { recordAuditLog, withTenant } from "@jibuks/db";

export interface TenantRow {
  readonly id: string;
  readonly name: string;
  readonly type: "BUSINESS" | "NGO" | "HOUSEHOLD";
  readonly base_currency: string;
  readonly accounting_framework: string;
  readonly plan_tier: string;
  readonly status: string;
  readonly created_at: string;
}

export interface OnboardInput {
  readonly tenantName: string;
  readonly tenantType: "BUSINESS" | "NGO" | "HOUSEHOLD";
  readonly baseCurrency: string;
  readonly externalIdpSubject: string;
  readonly userName: string;
  readonly email?: string;
  readonly phone?: string;
}

export interface OnboardResult {
  readonly tenant: TenantRow;
  readonly user: {
    readonly id: string;
    readonly tenant_id: string;
    readonly external_idp_subject: string;
    readonly name: string;
    readonly email: string | null;
    readonly phone: string | null;
    readonly status: string;
    readonly is_super_admin: boolean;
    readonly created_at: string;
  };
}

export async function onboardTenant(input: OnboardInput): Promise<OnboardResult> {
  const tenantId = randomUUID();
  const userId = randomUUID();

  return withTenant(tenantId, async (client) => {
    const tenantResult = await client.query<TenantRow>(
      `INSERT INTO tenants (id, name, type, base_currency) VALUES ($1, $2, $3, $4) RETURNING *`,
      [tenantId, input.tenantName, input.tenantType, input.baseCurrency],
    );
    const tenant = tenantResult.rows[0]!;

    const userResult = await client.query(
      `INSERT INTO users (id, tenant_id, external_idp_subject, name, email, phone, is_super_admin)
       VALUES ($1, $2, $3, $4, $5, $6, false)
       RETURNING *`,
      [userId, tenantId, input.externalIdpSubject, input.userName, input.email ?? null, input.phone ?? null],
    );
    const user = userResult.rows[0];

    await recordAuditLog(client, {
      tenantId,
      action: "CREATE",
      entityType: "tenant",
      entityId: tenantId,
      afterState: tenant,
      context: { actorUserId: userId },
    });
    await recordAuditLog(client, {
      tenantId,
      action: "CREATE",
      entityType: "user",
      entityId: userId,
      afterState: user,
      context: { actorUserId: userId },
    });

    return { tenant, user };
  });
}