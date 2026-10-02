/**
 * Roles repository.
 *
 * The ONLY file permitted to write raw SQL against `roles` and `user_roles`
 * (AD-02). Built-in roles are not stored -- see @jibuks/domain
 * permissions.ts -- so `roles` holds custom roles only, and a user_roles row
 * references either a built-in key (system_role) or a custom role (role_id).
 */

import { randomUUID } from "node:crypto";
import { DomainError, SYSTEM_ROLE_KEYS, isSystemRoleKey, type SystemRoleKey } from "@jibuks/domain";
import { recordAuditLog, withTenant, readAsTenant, type AuditContext } from "@jibuks/db";

/** A transaction-scoped client, as handed out by withTenant. */
export type TxClient = Parameters<Parameters<typeof withTenant>[1]>[0];

export interface RoleRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly permissions: readonly string[];
  readonly is_active: boolean;
  readonly created_by: string;
  readonly created_at: string;
}

/** One assignment, joined with its custom role (null for a built-in). */
export interface AssignmentRow {
  readonly user_id: string;
  readonly system_role: SystemRoleKey | null;
  readonly role_id: string | null;
  readonly role_name: string | null;
  readonly role_description: string | null;
  readonly role_permissions: readonly string[] | null;
  readonly role_is_active: boolean | null;
}

export async function listRoles(tenantId: string): Promise<RoleRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<RoleRow>(`SELECT * FROM roles ORDER BY lower(name) ASC`);
    return result.rows;
  });
}

export async function getRoleById(tenantId: string, roleId: string): Promise<RoleRow | null> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<RoleRow>(`SELECT * FROM roles WHERE id = $1`, [roleId]);
    return result.rows[0] ?? null;
  });
}

export interface CreateRoleInput {
  readonly tenantId: string;
  readonly name: string;
  readonly description?: string;
  readonly permissions: readonly string[];
}

export async function createRole(input: CreateRoleInput, audit: AuditContext): Promise<RoleRow> {
  return withTenant(input.tenantId, async (client) => {
    const result = await client.query<RoleRow>(
      `INSERT INTO roles (id, tenant_id, name, description, permissions, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [randomUUID(), input.tenantId, input.name, input.description ?? null, input.permissions, audit.actorUserId],
    );
    const role = result.rows[0]!;
    await recordAuditLog(client, {
      tenantId: input.tenantId,
      action: "CREATE",
      entityType: "role",
      entityId: role.id,
      afterState: role,
      context: audit,
    });
    return role;
  });
}

export interface UpdateRoleInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly permissions?: readonly string[];
  readonly isActive?: boolean;
}

export async function updateRole(
  tenantId: string,
  roleId: string,
  input: UpdateRoleInput,
  audit: AuditContext,
): Promise<RoleRow | null> {
  return withTenant(tenantId, async (client) => {
    const before = await client.query<RoleRow>(`SELECT * FROM roles WHERE id = $1 FOR UPDATE`, [roleId]);
    const existing = before.rows[0];
    if (!existing) {
      return null;
    }
    const result = await client.query<RoleRow>(
      `UPDATE roles
          SET name = $2, description = $3, permissions = $4, is_active = $5
        WHERE id = $1
       RETURNING *`,
      [
        roleId,
        input.name ?? existing.name,
        input.description !== undefined ? input.description : existing.description,
        input.permissions ?? existing.permissions,
        input.isActive ?? existing.is_active,
      ],
    );
    const role = result.rows[0]!;
    await recordAuditLog(client, {
      tenantId,
      action: "UPDATE",
      entityType: "role",
      entityId: role.id,
      beforeState: existing,
      afterState: role,
      context: audit,
    });
    return role;
  });
}

// Same order as GET /roles: built-ins in catalogue order, then custom roles
// by name. (Not created_at -- rows assigned in one transaction share it.)
// $2 = one user's id, or NULL for every user in the tenant.
const ASSIGNMENTS_SQL = `
  SELECT ur.user_id, ur.system_role, ur.role_id,
         r.name AS role_name, r.description AS role_description,
         r.permissions AS role_permissions, r.is_active AS role_is_active
    FROM user_roles ur
    LEFT JOIN roles r ON r.id = ur.role_id
   WHERE $2::uuid IS NULL OR ur.user_id = $2
   ORDER BY array_position($1::text[], ur.system_role) NULLS LAST, lower(r.name), ur.role_id`;

export async function listAssignments(tenantId: string, userId: string): Promise<AssignmentRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<AssignmentRow>(ASSIGNMENTS_SQL, [SYSTEM_ROLE_KEYS, userId]);
    return result.rows;
  });
}

/** Every user's assignments in the tenant, in one query (GET /users). */
export async function listAllAssignments(tenantId: string): Promise<AssignmentRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<AssignmentRow>(ASSIGNMENTS_SQL, [SYSTEM_ROLE_KEYS, null]);
    return result.rows;
  });
}

/**
 * Inserts role assignments using the CALLER'S client, so they commit or
 * roll back with whatever created the user (onboarding, invite accept,
 * user provisioning). Custom role ids are checked under RLS -- a foreign
 * key alone would accept another tenant's role id, since FK checks bypass
 * row-level security.
 */
export async function insertAssignments(
  client: TxClient,
  tenantId: string,
  userId: string,
  roleRefs: readonly string[],
  assignedBy: string | null,
): Promise<void> {
  const customIds = roleRefs.filter((ref) => !isSystemRoleKey(ref));
  if (customIds.length > 0) {
    const found = await client.query<{ id: string }>(`SELECT id FROM roles WHERE id = ANY($1::uuid[])`, [customIds]);
    const foundIds = new Set(found.rows.map((row) => row.id));
    const missing = customIds.find((id) => !foundIds.has(id));
    if (missing) {
      throw new DomainError("ROLE_NOT_FOUND", `Role ${missing} not found`);
    }
  }

  for (const ref of roleRefs) {
    await client.query(
      `INSERT INTO user_roles (id, tenant_id, user_id, system_role, role_id, assigned_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        tenantId,
        userId,
        isSystemRoleKey(ref) ? ref : null,
        isSystemRoleKey(ref) ? null : ref,
        assignedBy,
      ],
    );
  }
}

/**
 * Replaces a user's assignments in one transaction, refusing any change
 * that would leave the tenant with no active OWNER (it could then never
 * manage users or roles again). A per-tenant advisory lock serialises
 * concurrent role changes so two owners can't demote each other at once.
 */
export async function replaceAssignments(
  tenantId: string,
  userId: string,
  roleRefs: readonly string[],
  audit: AuditContext,
): Promise<AssignmentRow[]> {
  return withTenant(tenantId, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('user_roles:' || $1))`, [tenantId]);

    const before = await client.query<AssignmentRow>(ASSIGNMENTS_SQL, [SYSTEM_ROLE_KEYS, userId]);
    await client.query(`DELETE FROM user_roles WHERE user_id = $1`, [userId]);
    await insertAssignments(client, tenantId, userId, roleRefs, audit.actorUserId);

    const owners = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM user_roles ur
         JOIN users u ON u.id = ur.user_id
        WHERE ur.system_role = 'OWNER' AND u.status = 'ACTIVE'`,
    );
    if (owners.rows[0]!.n === 0) {
      throw new DomainError("LAST_OWNER", "A business must keep at least one active Owner");
    }

    const after = await client.query<AssignmentRow>(ASSIGNMENTS_SQL, [SYSTEM_ROLE_KEYS, userId]);
    await recordAuditLog(client, {
      tenantId,
      action: "UPDATE",
      entityType: "user_roles",
      entityId: userId,
      beforeState: before.rows,
      afterState: after.rows,
      context: audit,
    });
    return after.rows;
  });
}
