/**
 * Invites controllers -- HTTP layer only.
 *
 * Three different auth levels in this one module:
 *   create/list  -> full requireRealIdentity (existing tenant user)
 *   preview      -> no auth at all (shown before the invitee has logged in)
 *   accept       -> requireAuth0Token only, same tier as onboarding
 * See routes.ts for where each is actually enforced.
 */

import type { Request, Response } from "express";
import { createInviteSchema, acceptInviteSchema } from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import * as service from "./service.js";
import * as usersService from "../users/service.js";

function auditContextFrom(req: Request): AuditContext {
  if (!req.actorUserId) {
    throw new Error("actorUserId missing -- requireRealIdentity should have set this");
  }
  return {
    actorUserId: req.actorUserId,
    ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  };
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = createInviteSchema.parse(req.body);

  // The service needs the tenant's own name (for the email) -- fetched
  // here rather than threaded through some other way, since the
  // controller already has req.tenantId available.
  const tenant = await usersService.getTenantNameForController(req.tenantId!);

  const invite = await service.createInvite(
    {
      tenantId: req.tenantId!,
      tenantName: tenant,
      email: body.email,
      ...(body.name !== undefined ? { name: body.name } : {}),
    },
    auditContextFrom(req),
  );
  res.status(201).json(invite);
}

export async function list(req: Request, res: Response): Promise<void> {
  const invites = await service.listInvites(req.tenantId!);
  res.json({ data: invites });
}

export async function preview(req: Request, res: Response): Promise<void> {
  const token = req.params["token"]!;
  const result = await service.previewInvite(token);
  res.json(result);
}

export async function accept(req: Request, res: Response): Promise<void> {
  const token = req.params["token"]!;
  const sub = req.auth?.payload?.sub;
  if (!sub || typeof sub !== "string") {
    throw new Error("Token did not carry a subject claim -- requireAuth0Token should have rejected this already");
  }

  const body = acceptInviteSchema.parse(req.body);
  const result = await service.acceptInvite(token, sub, body.name);
  res.status(201).json(result);
}