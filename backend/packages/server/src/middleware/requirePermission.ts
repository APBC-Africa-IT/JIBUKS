/**
 * Route-level permission guard (FR-RBAC-01).
 *
 * SRS Section 5.5: "Authorisation is role-based, evaluated server-side on
 * every request. Client-side role checks are a presentation convenience
 * only and are never trusted."
 *
 * Must run after requireRealIdentity. The caller's effective permissions
 * are loaded once per request and cached on req.permissions.
 *
 * Every tenant route declares exactly one guard: requirePermission(...) or,
 * for the few routes any signed-in user may call (e.g. GET /users/me),
 * anyAuthenticatedUser. test/routeGuards.test.ts fails if a route has
 * neither, so a new endpoint can't ship unguarded by accident.
 */

import type { NextFunction, Request, Response } from "express";
import { DomainError, type Permission } from "@jibuks/domain";
import * as rolesService from "../modules/roles/service.js";

/** Marker read by the route-guard coverage test. */
export interface GuardMarker {
  readonly guard: Permission | "any-authenticated-user";
}

type GuardHandler = ((req: Request, res: Response, next: NextFunction) => void) & GuardMarker;

export async function loadPermissions(req: Request): Promise<ReadonlySet<Permission>> {
  if (!req.permissions) {
    req.permissions =
      req.tenantId && req.actorUserId
        ? await rolesService.effectivePermissions(req.tenantId, req.actorUserId)
        : new Set<Permission>();
  }
  return req.permissions;
}

export function requirePermission(permission: Permission): GuardHandler {
  const handler = (req: Request, _res: Response, next: NextFunction): void => {
    loadPermissions(req)
      .then((permissions) => {
        if (!permissions.has(permission)) {
          throw new DomainError("FORBIDDEN", `This action requires the "${permission}" permission`);
        }
        next();
      })
      .catch(next);
  };
  return Object.assign(handler, { guard: permission });
}

/** Explicitly marks a route as open to every signed-in tenant user. */
export const anyAuthenticatedUser: GuardHandler = Object.assign(
  (_req: Request, _res: Response, next: NextFunction): void => {
    next();
  },
  { guard: "any-authenticated-user" as const },
);
