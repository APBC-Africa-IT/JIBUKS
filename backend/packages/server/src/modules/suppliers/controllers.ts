/**
 * Suppliers controllers -- HTTP layer only. Parse request, call service,
 * shape response. All business logic lives in service.ts.
 */

import type { Request, Response } from "express";
import { createSupplierSchema, partyBalanceQuerySchema } from "@jibuks/domain";
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
  const body = createSupplierSchema.parse(req.body);
  const supplier = await service.createSupplier(
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
  res.status(201).json(supplier);
}

export async function list(req: Request, res: Response): Promise<void> {
  const { as_of } = partyBalanceQuerySchema.parse(req.query);
  const suppliers = await service.listSuppliers(req.tenantId!, as_of);
  res.json({ data: suppliers });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const { as_of } = partyBalanceQuerySchema.parse(req.query);
  const supplier = await service.getSupplier(req.tenantId!, req.params["id"]!, as_of);
  res.json(supplier);
}

export async function deactivate(req: Request, res: Response): Promise<void> {
  const supplier = await service.deactivateSupplier(req.tenantId!, req.params["id"]!, auditContextFrom(req));
  res.json(supplier);
}

export async function reactivate(req: Request, res: Response): Promise<void> {
  const supplier = await service.reactivateSupplier(req.tenantId!, req.params["id"]!, auditContextFrom(req));
  res.json(supplier);
}
