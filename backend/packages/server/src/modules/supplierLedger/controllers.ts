/**
 * Supplier ledger controllers -- HTTP layer only. Served under /suppliers
 * (see suppliers/routes.ts): the list and detail with last activity and
 * payment status, and a supplier's transaction history; and the Suppliers
 * hub's Overview at /payables-overview.
 */

import type { Request, Response } from "express";
import {
  listSuppliersQuerySchema,
  partyBalanceQuerySchema,
  payablesOverviewQuerySchema,
  supplierTransactionsQuerySchema,
} from "@jibuks/domain";
import * as service from "./service.js";

export async function list(req: Request, res: Response): Promise<void> {
  const query = listSuppliersQuerySchema.parse(req.query);
  const suppliers = await service.listSupplierEntries(req.tenantId!, {
    asOf: query.as_of,
    q: query.q,
    supplierTypeId: query.supplier_type_id,
  });
  res.json({ data: suppliers });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const { as_of } = partyBalanceQuerySchema.parse(req.query);
  res.json(await service.getSupplierEntry(req.tenantId!, req.params["id"]!, as_of));
}

export async function transactions(req: Request, res: Response): Promise<void> {
  const { from, to } = supplierTransactionsQuerySchema.parse(req.query);
  res.json(await service.getSupplierTransactions({ tenantId: req.tenantId!, supplierId: req.params["id"]!, from, to }));
}

export async function overview(req: Request, res: Response): Promise<void> {
  const query = payablesOverviewQuerySchema.parse(req.query);
  res.json(
    await service.getPayablesOverview({
      tenantId: req.tenantId!,
      asOf: query.as_of,
      dueSoonDays: query.due_soon_days,
      recentLimit: query.recent_limit,
    }),
  );
}
