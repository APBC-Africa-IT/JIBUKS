/**
 * Customer reports controllers -- HTTP layer only.
 */

import type { Request, Response } from "express";
import { followUpQuerySchema } from "@jibuks/domain";
import * as service from "./service.js";

export async function customersToFollowUp(req: Request, res: Response): Promise<void> {
  const { as_of, min_days_overdue } = followUpQuerySchema.parse(req.query);
  res.json(await service.getCustomersToFollowUp(req.tenantId!, as_of, min_days_overdue));
}
