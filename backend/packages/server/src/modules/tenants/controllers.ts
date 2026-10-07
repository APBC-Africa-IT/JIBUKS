/**
 * Tenants controllers -- HTTP layer only.
 */

import type { Request, Response } from "express";
import { updateTenantSchema } from "@jibuks/domain";
import * as service from "./service.js";

export async function get(req: Request, res: Response): Promise<void> {
  const tenant = await service.getTenant(req.tenantId!);
  res.json(tenant);
}

export async function update(req: Request, res: Response): Promise<void> {
  const body = updateTenantSchema.parse(req.body);
  const tenant = await service.updateTenant(
    req.tenantId!,
    {
      ...(body.taxIdentifier !== undefined ? { taxIdentifier: body.taxIdentifier } : {}),
      ...(body.manualJournalApprovalThresholdMinor !== undefined
        ? { manualJournalApprovalThresholdMinor: body.manualJournalApprovalThresholdMinor }
        : {}),
    },
    { actorUserId: req.actorUserId!, ...(req.ip !== undefined ? { ipAddress: req.ip } : {}) },
  );
  res.json(tenant);
}
