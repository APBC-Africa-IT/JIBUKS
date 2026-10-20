/**
 * Customer credit controllers -- HTTP layer only. Served at
 * GET /customers/{id}/credit, POST /invoices/{id}/apply-credit and
 * /customer-refunds.
 */

import type { Request, Response } from "express";
import { applyCreditSchema, createRefundSchema, listRefundsQuerySchema } from "@jibuks/domain";
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

export async function availableCredit(req: Request, res: Response): Promise<void> {
  res.json(await service.getAvailableCredit(req.tenantId!, req.params["id"]!));
}

export async function applyCredit(req: Request, res: Response): Promise<void> {
  const body = applyCreditSchema.parse(req.body);
  const invoice = await service.applyCredit(
    {
      tenantId: req.tenantId!,
      invoiceId: req.params["id"]!,
      clientUuid: body.clientUuid,
      amountMinor: body.amountMinor,
      date: body.date,
      sources: body.sources,
    },
    auditContextFrom(req),
  );
  res.status(201).json(invoice);
}

export async function createRefund(req: Request, res: Response): Promise<void> {
  const body = createRefundSchema.parse(req.body);
  const refund = await service.createRefund(
    {
      tenantId: req.tenantId!,
      clientUuid: body.clientUuid,
      customerId: body.customerId,
      amountMinor: body.amountMinor,
      date: body.date,
      method: body.method,
      paidFromAccountId: body.paidFromAccountId,
      reference: body.reference,
      memo: body.memo,
      sources: body.sources,
    },
    auditContextFrom(req),
  );
  res.status(201).json(refund);
}

export async function listRefunds(req: Request, res: Response): Promise<void> {
  const query = listRefundsQuerySchema.parse(req.query);
  res.json(
    await service.listRefunds(req.tenantId!, {
      customerId: query.customer_id,
      from: query.from,
      to: query.to,
      limit: query.limit,
      cursor: query.cursor,
    }),
  );
}

export async function getRefund(req: Request, res: Response): Promise<void> {
  res.json(await service.getRefund(req.tenantId!, req.params["id"]!));
}
