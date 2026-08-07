/**
 * Invites repository.
 *
 * The ONLY file permitted to write raw SQL against `invites` (AD-02).
 *
 * Two lookup functions exist deliberately: findInviteByTokenHash uses the
 * jibuks_auth_resolver pool (BYPASSRLS, column-scoped grant) because an
 * invitee has no tenant context yet -- the exact same reasoning as
 * findUserByExternalIdpSubject. Every other function here is ordinary
 * tenant-scoped access via withTenant/readAsTenant.
 */

import { randomUUID } from "node:crypto";
import { recordAuditLog, withTenant, readAsTenant, withAuthResolver, type AuditContext } from "@jibuks/db";

export interface InviteRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly email: string;
  readonly name: string | null;
  readonly token_hash: string;
  readonly status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
  readonly invited_by: string;
  readonly accepted_by: string | null;
  readonly created_at: string;
  readonly expires_at: string;
  readonly accepted_at: string | null;
}

export interface CreateInviteInput {
  readonly tenantId: string;
  readonly email: string;
  readonly name?: string;
  readonly tokenHash: string;
  readonly expiresAt: string;
}

export async function createInvite(input: CreateInviteInput, audit: AuditContext): Promise<InviteRow> {
  return withTenant(input.tenantId, async (client) => {
    const id = randomUUID();
    const result = await client.query<InviteRow>(
      `INSERT INTO invites (id, tenant_id, email, name, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [id, input.tenantId, input.email, input.name ?? null, input.tokenHash, audit.actorUserId, input.expiresAt],
    );
    const invite = result.rows[0]!;

    await recordAuditLog(client, {
      tenantId: input.tenantId,
      action: "CREATE",
      entityType: "invite",
      entityId: invite.id,
      afterState: { email: invite.email, status: invite.status }, // never log the hash
      context: audit,
    });

    return invite;
  });
}

export async function listInvites(tenantId: string): Promise<InviteRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<InviteRow>(`SELECT * FROM invites ORDER BY created_at DESC`);
    return result.rows;
  });
}

/**
 * The one deliberate cross-tenant exception, same pattern as
 * findUserByExternalIdpSubject. The invitee has no tenant context when
 * checking or accepting an invite -- that's exactly what's being resolved.
 */
export async function findInviteByTokenHash(tokenHash: string): Promise<InviteRow | null> {
  return withAuthResolver(async (client) => {
    const result = await client.query<InviteRow>(`SELECT * FROM invites WHERE token_hash = $1`, [tokenHash]);
    return result.rows[0] ?? null;
  });
}

/**
 * Marks an invite accepted. Runs via the auth-resolver pool for the same
 * reason as the lookup above -- the caller has no tenant context at this
 * point, since determining the tenant IS what accepting the invite does.
 */
export async function markInviteAccepted(inviteId: string, userId: string): Promise<void> {
  await withAuthResolver(async (client) => {
    await client.query(
      `UPDATE invites SET status = 'ACCEPTED', accepted_by = $2, accepted_at = now() WHERE id = $1`,
      [inviteId, userId],
    );
  });
}

/**
 * Both of these run via the auth-resolver pool, same as the invite lookup
 * itself -- shown to someone with no tenant context yet, on the preview
 * screen before they've logged in at all.
 */
export async function getTenantNameForInvite(tenantId: string): Promise<string> {
  return withAuthResolver(async (client) => {
    const result = await client.query<{ name: string }>(`SELECT name FROM tenants WHERE id = $1`, [tenantId]);
    return result.rows[0]?.name ?? "Unknown";
  });
}

export async function getInviterNameForInvite(userId: string): Promise<string> {
  return withAuthResolver(async (client) => {
    const result = await client.query<{ name: string }>(`SELECT name FROM users WHERE id = $1`, [userId]);
    return result.rows[0]?.name ?? "Unknown";
  });
}