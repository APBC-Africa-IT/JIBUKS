/**
 * Customer payments controllers -- HTTP layer only.
 */

import type { Request, Response } from "express";
import { createCustomerPaymentSchema, listCustomerPaymentsQuerySchema } from "@jibuks/domain";
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
  const body = createCustomerPaymentSchema.parse(req.body);
  const payment = await service.receivePayment(
    {
      tenantId: req.tenantId!,
      clientUuid: body.clientUuid,
      customerId: body.customerId,
      amountMinor: body.amountMinor,
      date: body.date,
      method: body.method,
      receivedAccountId: body.receivedAccountId,
      reference: body.reference,
      memo: body.memo,
      allocations: body.allocations,
    },
    auditContextFrom(req),
  );
  res.status(201).json(payment);
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = listCustomerPaymentsQuerySchema.parse(req.query);
  res.json(
    await service.listPayments(req.tenantId!, {
      customerId: query.customer_id,
      method: query.method,
      from: query.from,
      to: query.to,
      hasCredit: query.has_credit,
      q: query.q,
      limit: query.limit,
      cursor: query.cursor,
    }),
  );
}

export async function getOne(req: Request, res: Response): Promise<void> {
  res.json(await service.getPayment(req.tenantId!, req.params["id"]!));
}
