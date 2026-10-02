/**
 * Users service -- the public interface of this module.
 *
 * findUserByExternalIdpSubject is the one function that runs OUTSIDE tenant
 * scope, by necessity -- it's how the auth layer discovers which tenant a
 * verified identity belongs to in the first place. Every other function
 * here is ordinary tenant-scoped access.
 */

import { DEFAULT_ROLE, DomainError, type Permission } from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import * as repository from "./repository.js";
import type { UserRow } from "./repository.js";
import * as rolesService from "../roles/service.js";
import type { RoleView } from "../roles/service.js";

export interface CreateUserRequest {
  readonly tenantId: string;
  readonly externalIdpSubject: string;
  readonly name: string;
  readonly email?: string;
  readonly phone?: string;
  /** Built-in keys or custom role ids; defaults to [DEFAULT_ROLE]. */
  readonly roles?: readonly string[];
}

export async function createUser(request: CreateUserRequest, audit: AuditContext): Promise<UserRow> {
  const existing = await repository.findUserByExternalIdpSubject(request.externalIdpSubject);
  if (existing) {
    throw new DomainError("USER_ALREADY_EXISTS", `A user for this identity already exists (id ${existing.id})`);
  }

  const roles = request.roles ?? [DEFAULT_ROLE];
  await rolesService.assertAssignable(request.tenantId, roles);

  return repository.createUser(
    {
      tenantId: request.tenantId,
      externalIdpSubject: request.externalIdpSubject,
      name: request.name,
      ...(request.email !== undefined ? { email: request.email } : {}),
      ...(request.phone !== undefined ? { phone: request.phone } : {}),
    },
    audit,
    (client, user) => rolesService.assignInitialRoles(client, request.tenantId, user.id, roles, audit.actorUserId),
  );
}

export interface UserWithRoles extends UserRow {
  readonly roles: readonly RoleView[];
}

/** Every user with their roles, so a team screen needs one request. */
export async function listUsersWithRoles(tenantId: string): Promise<UserWithRoles[]> {
  const [users, rolesByUser] = await Promise.all([listUsers(tenantId), rolesService.getRolesByUser(tenantId)]);
  return users.map((user) => ({ ...user, roles: rolesByUser.get(user.id) ?? [] }));
}

export async function listUsers(tenantId: string): Promise<UserRow[]> {
  return repository.listUsers(tenantId);
}

export async function getUser(tenantId: string, userId: string): Promise<UserRow> {
  const user = await repository.getUserById(tenantId, userId);
  if (!user) {
    throw new DomainError("USER_NOT_FOUND", `User ${userId} not found`);
  }
  return user;
}
/** Thin passthrough so other modules can check identity existence without
 * reaching into this module's repository directly (AD-01). */

export async function findByExternalIdpSubject(externalIdpSubject: string): Promise<UserRow | null> {
  return repository.findUserByExternalIdpSubject(externalIdpSubject);
}

/**
 * Resolve a verified Auth0 `sub` claim to a real user + tenant. This is
 * what real authentication middleware will call, replacing the
 * X-Tenant-Id/X-Actor-User-Id headers entirely once wired in.
 */
export async function resolveIdentity(externalIdpSubject: string): Promise<UserRow> {
  const user = await repository.findUserByExternalIdpSubject(externalIdpSubject);
  if (!user) {
    throw new DomainError(
      "USER_NOT_FOUND",
      `No user is provisioned for identity ${externalIdpSubject}. An administrator must create a user record before this identity can access the API.`,
    );
  }
  if (user.status !== "ACTIVE") {
    throw new DomainError("USER_INACTIVE", `User ${user.id} is not active`);
  }
  return user;
}

/**
 * Used ONLY by the invites flow (acceptInvite) -- creates a user in a
 * tenant determined by a validated invite, not by an authenticated
 * caller's own tenant. Self-attributed for audit purposes, same reasoning
 * as onboarding: at the moment of creation, the new user is the only
 * party who could plausibly be the actor.
 */
export async function createUserFromInvite(input: {
  tenantId: string;
  externalIdpSubject: string;
  name: string;
  email?: string;
  role: string;
}): Promise<UserRow> {
  return repository.createUserSelfAttributed(
    {
      tenantId: input.tenantId,
      externalIdpSubject: input.externalIdpSubject,
      name: input.name,
      ...(input.email !== undefined ? { email: input.email } : {}),
    },
    (client, user) => rolesService.assignInitialRoles(client, input.tenantId, user.id, [input.role], user.id),
  );
}

export interface UserWithAccess extends UserRow {
  readonly roles: readonly RoleView[];
  readonly permissions: readonly Permission[];
}

/** A user plus their roles and effective permissions -- what GET /users/me
 * returns, so clients can hide actions the user can't perform. */
export async function getUserWithAccess(tenantId: string, userId: string): Promise<UserWithAccess> {
  const user = await getUser(tenantId, userId);
  const roles = await rolesService.getUserRoles(tenantId, userId);
  const permissions = await rolesService.effectivePermissions(tenantId, userId);
  return { ...user, roles, permissions: [...permissions].sort() };
}

export async function getUserRoles(tenantId: string, userId: string): Promise<RoleView[]> {
  await getUser(tenantId, userId);
  return rolesService.getUserRoles(tenantId, userId);
}

export async function setUserRoles(
  tenantId: string,
  userId: string,
  roles: readonly string[],
  audit: AuditContext,
): Promise<RoleView[]> {
  await getUser(tenantId, userId);
  return rolesService.setUserRoles(tenantId, userId, roles, audit);
}

export async function getTenantNameForController(tenantId: string): Promise<string> {
  return repository.getTenantName(tenantId);
}