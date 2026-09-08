/**
 * Customers controllers -- HTTP layer only. Parse request, call service,
 * shape response. All business logic lives in service.ts.
 */

import type { Request, Response } from "express";
import { createCustomerSchema, partyBalanceQuerySchema } from "@jibuks/domain";
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
  const body = createCustomerSchema.parse(req.body);
  const customer = await service.createCustomer(
    {
      tenantId: req.tenantId!,
      name: body.name,
      ...(body.phone ? { phone: body.phone } : {}),
      ...(body.email ? { email: body.email } : {}),
      ...(body.address ? { address: body.address } : {}),
      tags: body.tags,
    },
    auditContextFrom(req),
  );
  res.status(201).json(customer);
}

export async function list(req: Request, res: Response): Promise<void> {
  const { as_of } = partyBalanceQuerySchema.parse(req.query);
  const customers = await service.listCustomers(req.tenantId!, as_of);
  res.json({ data: customers });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const { as_of } = partyBalanceQuerySchema.parse(req.query);
  const customer = await service.getCustomer(req.tenantId!, req.params["id"]!, as_of);
  res.json(customer);
}

export async function deactivate(req: Request, res: Response): Promise<void> {
  const customer = await service.deactivateCustomer(req.tenantId!, req.params["id"]!, auditContextFrom(req));
  res.json(customer);
}

export async function reactivate(req: Request, res: Response): Promise<void> {
  const customer = await service.reactivateCustomer(req.tenantId!, req.params["id"]!, auditContextFrom(req));
  res.json(customer);
}
