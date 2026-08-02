/**
 * Users controllers -- HTTP layer only.
 */

import type { Request, Response } from "express";
import { createUserSchema } from "@jibuks/domain";
import * as service from "./service.js";

export async function create(req: Request, res: Response): Promise<void> {
  const body = createUserSchema.parse(req.body);
  const user = await service.createUser({
    tenantId: req.tenantId!,
    externalIdpSubject: body.externalIdpSubject,
    name: body.name,
    ...(body.email !== undefined ? { email: body.email } : {}),
    ...(body.phone !== undefined ? { phone: body.phone } : {}),
  });
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