/**
 * Payments controllers -- HTTP layer only.
 */

import type { Request, Response } from "express";
import { createStkPushSchema } from "@jibuks/domain";
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

export async function stkPush(req: Request, res: Response): Promise<void> {
  const body = createStkPushSchema.parse(req.body);
  const payment = await service.initiateStkPush(
    {
      tenantId: req.tenantId!,
      clientUuid: body.clientUuid,
      phone: body.phone,
      amountMinor: body.amountMinor,
      currency: body.currency,
      ...(body.receivedAccountId !== undefined ? { receivedAccountId: body.receivedAccountId } : {}),
      creditAccountId: body.creditAccountId,
      ...(body.customerId !== undefined ? { customerId: body.customerId } : {}),
      ...(body.accountReference !== undefined ? { accountReference: body.accountReference } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.taxAmountMinor > 0 ? { taxAccountId: body.taxAccountId!, taxAmountMinor: body.taxAmountMinor } : {}),
    },
    auditContextFrom(req),
  );
  // 202: the prompt is on its way; the outcome arrives asynchronously.
  res.status(202).json(payment);
}

export async function repost(req: Request, res: Response): Promise<void> {
  const payment = await service.repostPayment(req.tenantId!, req.params["id"]!, auditContextFrom(req));
  res.json(payment);
}

export async function list(req: Request, res: Response): Promise<void> {
  const payments = await service.listPayments(req.tenantId!);
  res.json({ data: payments });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const payment = await service.getPayment(req.tenantId!, req.params["id"]!);
  res.json(payment);
}

/**
 * Safaricom's STK callback. Answers in Daraja's own acknowledgement shape;
 * errors (unknown payment, bad secret) still go through errorHandler.
 */
export async function stkCallback(req: Request, res: Response): Promise<void> {
  await service.handleStkCallback(req.params["tenantId"]!, req.params["paymentId"]!, req.params["token"]!, req.body);
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
}
