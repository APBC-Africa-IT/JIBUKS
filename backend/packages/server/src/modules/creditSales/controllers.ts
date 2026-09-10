/**
 * Credit sales controllers -- HTTP layer only.
 */

import type { Request, Response } from "express";
import { createCreditSaleSchema } from "@jibuks/domain";
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
  const body = createCreditSaleSchema.parse(req.body);
  const journal = await service.createCreditSale(
    {
      tenantId: req.tenantId!,
      clientUuid: body.clientUuid,
      ...(body.branchId ? { branchId: body.branchId } : {}),
      customerId: body.customerId,
      receivableAccountId: body.receivableAccountId,
      date: body.date,
      currency: body.currency,
      ...(body.reference ? { reference: body.reference } : {}),
      ...(body.description ? { description: body.description } : {}),
      lines: body.lines.map((line) => ({
        incomeAccountId: line.incomeAccountId,
        amountMinor: line.amountMinor,
        ...(line.narrative ? { narrative: line.narrative } : {}),
      })),
      ...(body.taxAccountId ? { taxAccountId: body.taxAccountId } : {}),
      taxAmountMinor: body.taxAmountMinor,
    },
    auditContextFrom(req),
  );
  res.status(201).json(journal);
}
