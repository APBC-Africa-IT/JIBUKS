/**
 * Aging controllers -- HTTP layer only.
 */

import type { Request, Response } from "express";
import { agingQuerySchema, payablesAgingQuerySchema } from "@jibuks/domain";
import * as service from "./service.js";

export async function receivables(req: Request, res: Response): Promise<void> {
  const { as_of, customer_id } = agingQuerySchema.parse(req.query);
  const report = customer_id
    ? await service.getCustomerAging(req.tenantId!, customer_id, as_of)
    : await service.getReceivablesAging(req.tenantId!, as_of);
  res.json(report);
}

export async function payables(req: Request, res: Response): Promise<void> {
  const { as_of, supplier_id } = payablesAgingQuerySchema.parse(req.query);
  const report = supplier_id
    ? await service.getSupplierAging(req.tenantId!, supplier_id, as_of)
    : await service.getPayablesAging(req.tenantId!, as_of);
  res.json(report);
}
