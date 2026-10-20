/**
 * Customer ledger controllers -- HTTP layer only. Served under /customers
 * (see customers/routes.ts): the list and detail with last activity, and a
 * customer's transaction history.
 */

import type { Request, Response } from "express";
import { customerTransactionsQuerySchema, listCustomersQuerySchema, partyBalanceQuerySchema } from "@jibuks/domain";
import * as service from "./service.js";

export async function list(req: Request, res: Response): Promise<void> {
  const { as_of, q } = listCustomersQuerySchema.parse(req.query);
  const customers = await service.listCustomersWithActivity(req.tenantId!, { asOf: as_of, q });
  res.json({ data: customers });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const { as_of } = partyBalanceQuerySchema.parse(req.query);
  res.json(await service.getCustomerWithActivity(req.tenantId!, req.params["id"]!, as_of));
}

export async function transactions(req: Request, res: Response): Promise<void> {
  const { from, to } = customerTransactionsQuerySchema.parse(req.query);
  res.json(await service.getCustomerTransactions({ tenantId: req.tenantId!, customerId: req.params["id"]!, from, to }));
}
