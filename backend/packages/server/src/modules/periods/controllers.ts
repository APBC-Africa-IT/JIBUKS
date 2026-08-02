/**
 * Periods controllers -- HTTP layer only.
 */

import type { Request, Response } from "express";
import { createPeriodSchema } from "@jibuks/domain";
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
  const body = createPeriodSchema.parse(req.body);
  const period = await service.createPeriod(
    { tenantId: req.tenantId!, startDate: body.startDate, endDate: body.endDate },
    auditContextFrom(req),
  );
  res.status(201).json(period);
}

export async function list(req: Request, res: Response): Promise<void> {
  const periods = await service.listPeriods(req.tenantId!);
  res.json({ data: periods });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const period = await service.getPeriod(req.tenantId!, req.params["id"]!);
  res.json(period);
}

export async function close(req: Request, res: Response): Promise<void> {
  const period = await service.closePeriod(req.tenantId!, req.params["id"]!, auditContextFrom(req));
  res.json(period);
}

export async function reopen(req: Request, res: Response): Promise<void> {
  const period = await service.reopenPeriod(req.tenantId!, req.params["id"]!, auditContextFrom(req));
  res.json(period);
}