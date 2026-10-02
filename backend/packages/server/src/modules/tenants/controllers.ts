/**
 * Tenants controllers -- HTTP layer only.
 */

import type { Request, Response } from "express";
import * as service from "./service.js";

export async function get(req: Request, res: Response): Promise<void> {
  const tenant = await service.getTenant(req.tenantId!);
  res.json(tenant);
}
