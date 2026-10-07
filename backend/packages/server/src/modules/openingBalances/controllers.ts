/**
 * Opening balances controllers -- HTTP layer only.
 */

import type { Request, Response } from "express";
import { openingBalancesSchema } from "@jibuks/domain";
import * as service from "./service.js";

export async function get(req: Request, res: Response): Promise<void> {
  res.json(await service.getOpeningBalances(req.tenantId!));
}

export async function put(req: Request, res: Response): Promise<void> {
  const body = openingBalancesSchema.parse(req.body);
  const result = await service.setOpeningBalances(
    {
      tenantId: req.tenantId!,
      date: body.date,
      lines: body.lines.map((line) => ({
        accountId: line.accountId,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
        ...(line.narrative !== undefined ? { narrative: line.narrative } : {}),
        ...(line.customerId !== undefined ? { customerId: line.customerId } : {}),
        ...(line.supplierId !== undefined ? { supplierId: line.supplierId } : {}),
        ...(line.projectId !== undefined ? { projectId: line.projectId } : {}),
        ...(line.department !== undefined ? { department: line.department } : {}),
      })),
    },
    { actorUserId: req.actorUserId!, ...(req.ip !== undefined ? { ipAddress: req.ip } : {}) },
  );
  res.json(result);
}
