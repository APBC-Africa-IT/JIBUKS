/**
 * Supplier credit controllers -- HTTP layer only. Served at
 * GET /suppliers/{id}/credit, POST /supplier-bills/{id}/apply-credit and
 * /supplier-refunds.
 */

import type { Request, Response } from "express";
import { applySupplierCreditSchema, createSupplierRefundSchema, listSupplierRefundsQuerySchema } from "@jibuks/domain";
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
  const body = applySupplierCreditSchema.parse(req.body);
  const bill = await service.applyCredit(
    {
      tenantId: req.tenantId!,
      billId: req.params["id"]!,
      clientUuid: body.clientUuid,
      amountMinor: body.amountMinor,
      date: body.date,
      sources: body.sources,
    },
    auditContextFrom(req),
  );
  res.status(201).json(bill);
}

export async function createRefund(req: Request, res: Response): Promise<void> {
  const body = createSupplierRefundSchema.parse(req.body);
  const refund = await service.createRefund(
    {
      tenantId: req.tenantId!,
      clientUuid: body.clientUuid,
      supplierId: body.supplierId,
      amountMinor: body.amountMinor,
      date: body.date,
      method: body.method,
      receivedAccountId: body.receivedAccountId,
      reference: body.reference,
      memo: body.memo,
      sources: body.sources,
    },
    auditContextFrom(req),
  );
  res.status(201).json(refund);
}

export async function listRefunds(req: Request, res: Response): Promise<void> {
  const query = listSupplierRefundsQuerySchema.parse(req.query);
  res.json(
    await service.listRefunds(req.tenantId!, {
      supplierId: query.supplier_id,
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
