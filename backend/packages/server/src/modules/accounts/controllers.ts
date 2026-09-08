/**
 * Accounts controllers -- HTTP layer only. Parse request, call service,
 * shape response. All business logic lives in service.ts; controllers
 * should stay thin enough to read in one glance.
 */

import type { Request, Response } from "express";
import { accountBalanceQuerySchema, createAccountSchema } from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import * as service from "./service.js";

function auditContextFrom(req: Request): AuditContext {
  // req.actorUserId is set by requireRealIdentity, from a cryptographically
  // verified Auth0 token resolved against the users table -- no longer a
  // client-supplied header.
  if (!req.actorUserId) {
    throw new Error("actorUserId missing -- requireRealIdentity should have set this");
  }
  return {
    actorUserId: req.actorUserId,
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
  const { as_of } = accountBalanceQuerySchema.parse(req.query);
  const accounts = await service.listAccounts(req.tenantId!, as_of);
  res.json({ data: accounts });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const { as_of } = accountBalanceQuerySchema.parse(req.query);
  const account = await service.getAccount(req.tenantId!, req.params["id"]!, as_of);
  res.json(account);
}

export async function deactivate(req: Request, res: Response): Promise<void> {
  const account = await service.deactivateAccount(req.tenantId!, req.params["id"]!, auditContextFrom(req));
  res.json(account);
}

export async function reactivate(req: Request, res: Response): Promise<void> {
  const account = await service.reactivateAccount(req.tenantId!, req.params["id"]!, auditContextFrom(req));
  res.json(account);
}