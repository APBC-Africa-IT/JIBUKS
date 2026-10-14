/**
 * Cheque payments controllers -- HTTP layer only.
 */

import type { Request, Response } from "express";
import { createChequePaymentSchema, listChequePaymentsQuerySchema } from "@jibuks/domain";
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

/** Drops undefined values so optional fields stay absent (exactOptionalPropertyTypes). */
function defined<T extends object>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as never;
}

export async function create(req: Request, res: Response): Promise<void> {
  const { lines, ...body } = createChequePaymentSchema.parse(req.body);
  const cheque = await service.createChequePayment(
    { ...defined(body), lines: lines.map((line) => defined(line)) as never, tenantId: req.tenantId! },
    auditContextFrom(req),
  );
  res.status(201).json(cheque);
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = listChequePaymentsQuerySchema.parse(req.query);
  const page = await service.listChequePayments(
    req.tenantId!,
    defined({ supplierId: query.supplier_id, from: query.from, to: query.to, limit: query.limit, cursor: query.cursor }),
  );
  res.json(page);
}

export async function getOne(req: Request, res: Response): Promise<void> {
  res.json(await service.getChequePayment(req.tenantId!, req.params["id"]!));
}
