/**
 * Accounts controllers -- HTTP layer only. Parse request, call service,
 * shape response. All business logic lives in service.ts; controllers
 * should stay thin enough to read in one glance.
 */

import type { Request, Response } from "express";
import { createAccountSchema } from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import * as service from "./service.js";

/**
 * TEMPORARY: reads the actor from a header, standing in for a validated
 * JWT claim until identity/auth exists. Same caveat as tenantContext.ts.
 */
function auditContextFrom(req: Request): AuditContext {
  const actorUserId = req.header("X-Actor-User-Id");
  if (!actorUserId) {
    throw new Error("X-Actor-User-Id header is required (temporary stand-in until identity/auth is built)");
  }
  return {
    actorUserId,
    ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  };
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = createAccountSchema.parse(req.body);
  const account = await service.createAccount(
    {
      tenantId: req.tenantId!,
      code: body.code,
      name: body.name,
      type: body.type,
      ...(body.parentAccountId ? { parentAccountId: body.parentAccountId } : {}),
      ...(body.currency ? { currency: body.currency } : {}),
      tags: body.tags,
    },
    auditContextFrom(req),
  );
  res.status(201).json(account);
}

export async function list(req: Request, res: Response): Promise<void> {
  const accounts = await service.listAccounts(req.tenantId!);
  res.json({ data: accounts });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const account = await service.getAccount(req.tenantId!, req.params["id"]!);
  res.json(account);
}

export async function deactivate(req: Request, res: Response): Promise<void> {
  const account = await service.deactivateAccount(req.tenantId!, req.params["id"]!, auditContextFrom(req));
  res.json(account);
}