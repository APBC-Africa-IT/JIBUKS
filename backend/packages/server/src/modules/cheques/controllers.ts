/**
 * Cheques controllers -- HTTP layer only.
 */

import type { Request, Response } from "express";
import { createWriteChequeSchema } from "@jibuks/domain";
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
  const body = createWriteChequeSchema.parse(req.body);
  const journal = await service.createWriteCheque(
    {
      tenantId: req.tenantId!,
      clientUuid: body.clientUuid,
      ...(body.branchId ? { branchId: body.branchId } : {}),
      bankAccountId: body.bankAccountId,
      date: body.date,
      currency: body.currency,
      ...(body.reference ? { reference: body.reference } : {}),
      ...(body.description ? { description: body.description } : {}),
      lines: body.lines.map((line) => ({
        accountId: line.accountId,
        amountMinor: line.amountMinor,
        ...(line.narrative ? { narrative: line.narrative } : {}),
        ...(line.customerId ? { customerId: line.customerId } : {}),
        ...(line.supplierId ? { supplierId: line.supplierId } : {}),
      })),
    },
    auditContextFrom(req),
  );
  res.status(201).json(journal);
}
