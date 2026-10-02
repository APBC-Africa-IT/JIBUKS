/**
 * Roles service -- the public interface of this module (FR-RBAC-01/02).
 *
 * Presents built-in and custom roles uniformly as RoleView: a built-in's
 * id is its key ("CASHIER"), a custom role's id is its uuid. Clients pass
 * either form wherever a role is referenced.
 */

import {
  DomainError,
  SYSTEM_ROLES,
  SYSTEM_ROLE_KEYS,
  isPermission,
  isSystemRoleKey,
  isUuid,
  type Permission,
} from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import * as repository from "./repository.js";
import type { AssignmentRow, RoleRow, TxClient } from "./repository.js";

export interface RoleView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly system: boolean;
  readonly isActive: boolean;
  readonly permissions: readonly Permission[];
}

/** Drops any stored permission no longer in the catalogue, rather than
 * granting something the server doesn't know how to check. */
function knownPermissions(stored: readonly string[]): Permission[] {
  return stored.filter(isPermission);
}

function systemRoleViews(): RoleView[] {
  return SYSTEM_ROLE_KEYS.map((key) => ({
    id: key,
    name: SYSTEM_ROLES[key].name,
    description: SYSTEM_ROLES[key].description,
    system: true,
    isActive: true,
    permissions: SYSTEM_ROLES[key].permissions,
  }));
}

function customRoleView(row: RoleRow): RoleView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    system: false,
    isActive: row.is_active,
    permissions: knownPermissions(row.permissions),
  };
}

function assignmentView(row: AssignmentRow): RoleView {
  if (row.system_role) {
    const role = SYSTEM_ROLES[row.system_role];
    return {
      id: role.key,
      name: role.name,
      description: role.description,
      system: true,
      isActive: true,
      permissions: role.permissions,
    };
  }
  return {
    id: row.role_id!,
    name: row.role_name!,
    description: row.role_description,
    system: false,
    isActive: row.role_is_active!,
    permissions: knownPermissions(row.role_permissions ?? []),
  };
}

export async function listRoles(tenantId: string): Promise<RoleView[]> {
  const custom = await repository.listRoles(tenantId);
  return [...systemRoleViews(), ...custom.map(customRoleView)];
}

export async function getRole(tenantId: string, roleRef: string): Promise<RoleView> {
  if (isSystemRoleKey(roleRef)) {
    return systemRoleViews().find((role) => role.id === roleRef)!;
  }
  const row = await findCustomRole(tenantId, roleRef);
  return customRoleView(row);
}

async function findCustomRole(tenantId: string, roleId: string): Promise<RoleRow> {
  if (isSystemRoleKey(roleId)) {
    throw new DomainError("ROLE_IMMUTABLE", `${roleId} is a built-in role and cannot be changed`);
  }
  const row = isUuid(roleId) ? await repository.getRoleById(tenantId, roleId) : null;
  if (!row) {
    throw new DomainError("ROLE_NOT_FOUND", `Role ${roleId} not found`);
  }
  return row;
}

export interface CreateRoleRequest {
  readonly tenantId: string;
  readonly name: string;
  readonly description?: string;
  readonly permissions: readonly Permission[];
}

export async function createRole(request: CreateRoleRequest, audit: AuditContext): Promise<RoleView> {
  const row = await repository.createRole(request, audit);
  return customRoleView(row);
}

export interface UpdateRoleRequest {
  readonly name?: string;
  readonly description?: string | null;
  readonly permissions?: readonly Permission[];
}

export async function updateRole(
  tenantId: string,
  roleId: string,
  request: UpdateRoleRequest,
  audit: AuditContext,
): Promise<RoleView> {
  await findCustomRole(tenantId, roleId);
  const row = await repository.updateRole(tenantId, roleId, request, audit);
  return customRoleView(row!);
}

/** A deactivated role stays assigned but grants nothing until reactivated. */
export async function setRoleActive(
  tenantId: string,
  roleId: string,
  isActive: boolean,
  audit: AuditContext,
): Promise<RoleView> {
  await findCustomRole(tenantId, roleId);
  const row = await repository.updateRole(tenantId, roleId, { isActive }, audit);
  return customRoleView(row!);
}

/**
 * Checks a role can be handed out right now (new invite, role change):
 * built-in, or a custom role that exists in this tenant and is active.
 */
export async function assertAssignable(tenantId: string, roleRefs: readonly string[]): Promise<void> {
  for (const ref of roleRefs) {
    if (isSystemRoleKey(ref)) {
      continue;
    }
    const row = await repository.getRoleById(tenantId, ref);
    if (!row) {
      throw new DomainError("ROLE_NOT_FOUND", `Role ${ref} not found`);
    }
    if (!row.is_active) {
      throw new DomainError("ROLE_NOT_FOUND", `Role ${ref} is deactivated and cannot be assigned`);
    }
  }
}

/**
 * Assigns roles to a just-created user inside the creator's own
 * transaction (onboarding, invite accept, user provisioning), so a user
 * never exists without their roles.
 */
export async function assignInitialRoles(
  client: TxClient,
  tenantId: string,
  userId: string,
  roleRefs: readonly string[],
  assignedBy: string | null,
): Promise<void> {
  await repository.insertAssignments(client, tenantId, userId, roleRefs, assignedBy);
}

export async function getUserRoles(tenantId: string, userId: string): Promise<RoleView[]> {
  const rows = await repository.listAssignments(tenantId, userId);
  return rows.map(assignmentView);
}

/** Every user's roles in the tenant, keyed by user id. Users with no
 * assignment are absent from the map. */
export async function getRolesByUser(tenantId: string): Promise<Map<string, RoleView[]>> {
  const byUser = new Map<string, RoleView[]>();
  for (const row of await repository.listAllAssignments(tenantId)) {
    const roles = byUser.get(row.user_id) ?? [];
    roles.push(assignmentView(row));
    byUser.set(row.user_id, roles);
  }
  return byUser;
}

/** Replaces a user's roles. Callers must have confirmed the user exists. */
export async function setUserRoles(
  tenantId: string,
  userId: string,
  roleRefs: readonly string[],
  audit: AuditContext,
): Promise<RoleView[]> {
  await assertAssignable(tenantId, roleRefs);
  const rows = await repository.replaceAssignments(tenantId, userId, roleRefs, audit);
  return rows.map(assignmentView);
}

/** Union of permissions across the user's roles; inactive custom roles grant nothing. */
export async function effectivePermissions(tenantId: string, userId: string): Promise<Set<Permission>> {
  const roles = await getUserRoles(tenantId, userId);
  const permissions = new Set<Permission>();
  for (const role of roles) {
    if (!role.isActive) {
      continue;
    }
    for (const permission of role.permissions) {
      permissions.add(permission);
    }
  }
  return permissions;
}
