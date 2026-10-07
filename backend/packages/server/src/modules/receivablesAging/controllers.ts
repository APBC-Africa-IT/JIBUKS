/**
 * Receivables aging controllers -- HTTP layer only.
 */

import type { Request, Response } from "express";
import { agingQuerySchema } from "@jibuks/domain";
import * as service from "./service.js";

export async function get(req: Request, res: Response): Promise<void> {
  const { as_of, customer_id } = agingQuerySchema.parse(req.query);
  const report = customer_id
    ? await service.getCustomerAging(req.tenantId!, customer_id, as_of)
    : await service.getReceivablesAging(req.tenantId!, as_of);
  res.json(report);
}
