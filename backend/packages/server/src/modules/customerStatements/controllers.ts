/**
 * Customer statements controllers -- HTTP layer only.
 */

import type { Request, Response } from "express";
import { createStatementSchema, listStatementsQuerySchema } from "@jibuks/domain";
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
  const body = createStatementSchema.parse(req.body);
  const statement = await service.createStatement(
    {
      tenantId: req.tenantId!,
      clientUuid: body.clientUuid,
      customerId: body.customerId,
      from: body.from,
      to: body.to,
      message: body.message,
    },
    auditContextFrom(req),
  );
  res.status(201).json(statement);
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = listStatementsQuerySchema.parse(req.query);
  res.json(
    await service.listStatements(req.tenantId!, {
      customerId: query.customer_id,
      sent: query.sent,
      q: query.q,
      limit: query.limit,
      cursor: query.cursor,
    }),
  );
}

export async function getOne(req: Request, res: Response): Promise<void> {
  res.json(await service.getStatement(req.tenantId!, req.params["id"]!));
}

export async function pdf(req: Request, res: Response): Promise<void> {
  const { filename, pdf: body } = await service.getStatementPdf(req.tenantId!, req.params["id"]!);
  res
    .status(200)
    .type("application/pdf")
    .set("Content-Disposition", `inline; filename="${filename}"`)
    .set("Cache-Control", "private, no-store")
    .send(body);
}

export async function markSent(req: Request, res: Response): Promise<void> {
  res.json(await service.markSent(req.tenantId!, req.params["id"]!, auditContextFrom(req)));
}
