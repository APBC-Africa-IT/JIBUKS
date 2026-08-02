/**
 * Real identity resolution: verifies an Auth0 JWT, then resolves its `sub` 
 * claim to a real tenant/user via the users module's resolveIdentity().
 *
 * This is the replacement for tenantContext.ts's header-based stand-in.
 * Composed of two steps that stay deliberately separate:
 *   1. requireAuth0Token -- cryptographic verification only (auth0.ts)
 *   2. resolveIdentity -- database lookup, mapping a verified identity to
 *      a real tenant_id/user_id (users/service.ts)
 *
 * Rolling out module by module: this middleware is applied to routes
 * explicitly, one module at a time, rather than replacing tenantContext
 * globally in one move -- see the rollout plan discussed before this file
 * was written.
 */

import type { NextFunction, Request, Response } from "express";
import { requireAuth0Token } from "./auth0.js";
import * as usersService from "../modules/users/service.js";

async function attachResolvedIdentity(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sub = req.auth?.payload?.sub;
  if (!sub) {
    res.status(401).type("application/problem+json").json({
      type: "tag:jibuks,2026:error/UNAUTHORIZED",
      title: "UNAUTHORIZED",
      status: 401,
      detail: "Token did not carry a subject claim",
    });
    return;
  }

  try {
    const user = await usersService.resolveIdentity(sub);
    if (user.tenant_id) {
      req.tenantId = user.tenant_id;
    }
    req.actorUserId = user.id;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * The full chain: verify the token is genuine, THEN resolve it to a real
 * tenant/user. Applied as a pair -- always use both together, in this order.
 */
export const requireRealIdentity = [requireAuth0Token, attachResolvedIdentity];
