/**
 * Users repository.
 *
 * The ONLY file permitted to write raw SQL against `users` (AD-02).
 *
 * Note on audit logging: audit_logs.actor_user_id has a NOT NULL foreign
 * key into users. Since user creation now requires an authenticated caller
 * (requireRealIdentity), the action is attributed to that caller -- never
 * to the newly created user. Self-service onboarding of a tenant's very
 * first user is a separate, public flow.
 */

import { randomUUID } from "node:crypto";
import { recordAuditLog, withTenant, readAsTenant, withAuthResolver, type AuditContext } from "@jibuks/db";

export interface UserRow {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly external_idp_subject: string;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly status: "ACTIVE" | "SUSPENDED";
  readonly mfa_enabled: boolean;
  readonly is_super_admin: boolean;
  readonly created_at: string;
}

export interface CreateUserInput {
  readonly tenantId: string;
  readonly externalIdpSubject: string;
  readonly name: string;
  readonly email?: string;
  readonly phone?: string;
}

export async function createUser(input: CreateUserInput, audit: AuditContext): Promise<UserRow> {
  return withTenant(input.tenantId, async (client) => {
    const id = randomUUID();
    const result = await client.query<UserRow>(
      `INSERT INTO users (id, tenant_id, external_idp_subject, name, email, phone, is_super_admin)
       VALUES ($1, $2, $3, $4, $5, $6, false)
       RETURNING *`,
      [id, input.tenantId, input.externalIdpSubject, input.name, input.email ?? null, input.phone ?? null],
    );
    const user = result.rows[0]!;

    // The authenticated caller is the actor -- see file header.
    await recordAuditLog(client, {
      tenantId: input.tenantId,
      action: "CREATE",
      entityType: "user",
      entityId: user.id,
      afterState: user,
      context: audit,
    });

    return user;
  });
}

export async function listUsers(tenantId: string): Promise<UserRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<UserRow>(`SELECT * FROM users ORDER BY created_at ASC`);
    return result.rows;
  });
}

export async function getUserById(tenantId: string, userId: string): Promise<UserRow | null> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [userId]);
    return result.rows[0] ?? null;
  });
}

/**
 * The one deliberate exception to RLS in this module. Uses the dedicated
 * jibuks_auth_resolver role (SELECT-only, BYPASSRLS) so this lookup can
 * genuinely search across all tenants -- necessary because the tenant is
 * exactly what's being discovered here.
 */
export async function findUserByExternalIdpSubject(externalIdpSubject: string): Promise<UserRow | null> {
  return withAuthResolver(async (client) => {
    const result = await client.query<UserRow>(`SELECT * FROM users WHERE external_idp_subject = $1`, [
      externalIdpSubject,
    ]);
    return result.rows[0] ?? null;
  });
}

/**
 * Creates a user who is the actor of their own creation -- used only where
 * no other authenticated party exists yet (invite acceptance, mirroring
 * onboarding's same reasoning). Distinct from createUser(), which always
 * requires and attributes to a real, separate, authenticated caller.
 */
export async function createUserSelfAttributed(input: CreateUserInput): Promise<UserRow> {
  return withTenant(input.tenantId, async (client) => {
    const id = randomUUID();
    const result = await client.query<UserRow>(
      `INSERT INTO users (id, tenant_id, external_idp_subject, name, email, phone, is_super_admin)
       VALUES ($1, $2, $3, $4, $5, $6, false)
       RETURNING *`,
      [id, input.tenantId, input.externalIdpSubject, input.name, input.email ?? null, input.phone ?? null],
    );
    const user = result.rows[0]!;

    await recordAuditLog(client, {
      tenantId: input.tenantId,
      action: "CREATE",
      entityType: "user",
      entityId: user.id,
      afterState: user,
      context: { actorUserId: user.id },
    });

    return user;
  });
}