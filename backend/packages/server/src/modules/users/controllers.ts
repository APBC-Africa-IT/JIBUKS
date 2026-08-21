/**
 * Users controllers -- HTTP layer only.
 */

import type { Request, Response } from "express";
import { createUserSchema } from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import * as service from "./service.js";

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
  const body = createUserSchema.parse(req.body);
  const user = await service.createUser(
    {
      tenantId: req.tenantId!,
      externalIdpSubject: body.externalIdpSubject,
      name: body.name,
      ...(body.email !== undefined ? { email: body.email } : {}),
      ...(body.phone !== undefined ? { phone: body.phone } : {}),
    },
    auditContextFrom(req),
  );
  res.status(201).json(user);
}

export async function list(req: Request, res: Response): Promise<void> {
  const users = await service.listUsers(req.tenantId!);
  res.json({ data: users });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const user = await service.getUser(req.tenantId!, req.params["id"]!);
  res.json(user);
}

/**
 * "Who am I" -- lets a client check whether the current token's identity
 * already has a platform account, without guessing locally or reusing
 * /onboarding as a de-facto check endpoint. Requires only that
 * requireRealIdentity resolved successfully; if it didn't, that middleware
 * has already thrown 404 USER_NOT_FOUND before this function ever runs.
 */
export async function me(req: Request, res: Response): Promise<void> {
  const user = await service.getUser(req.tenantId!, req.actorUserId!);
  res.json(user);
}