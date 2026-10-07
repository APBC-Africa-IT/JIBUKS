/**
 * Supplier bills controllers -- HTTP layer only.
 */

import type { Request, Response } from "express";
import {
  cancelInvoiceSchema,
  createDebitNoteSchema,
  createSupplierBillSchema,
  listSupplierBillsQuerySchema,
  recordBillPaymentSchema,
  updateSupplierBillSchema,
} from "@jibuks/domain";
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

/** Drops undefined values so optional fields stay absent (exactOptionalPropertyTypes). */
function defined<T extends object>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as never;
}

function lines(bodyLines: ReadonlyArray<object>) {
  return bodyLines.map((line) => defined(line)) as never;
}

export async function create(req: Request, res: Response): Promise<void> {
  const { lines: bodyLines, ...body } = createSupplierBillSchema.parse(req.body);
  const bill = await service.createBill(
    { ...defined(body), lines: lines(bodyLines), tenantId: req.tenantId! },
    auditContextFrom(req),
  );
  res.status(201).json(bill);
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = listSupplierBillsQuerySchema.parse(req.query);
  const page = await service.listBills(
    req.tenantId!,
    defined({
      status: query.status,
      kind: query.kind,
      supplierId: query.supplier_id,
      from: query.from,
      to: query.to,
      limit: query.limit,
      cursor: query.cursor,
    }),
  );
  res.json(page);
}

export async function getOne(req: Request, res: Response): Promise<void> {
  res.json(await service.getBill(req.tenantId!, req.params["id"]!));
}

export async function update(req: Request, res: Response): Promise<void> {
  const { lines: bodyLines, ...body } = updateSupplierBillSchema.parse(req.body);
  const bill = await service.updateBill(
    req.tenantId!,
    req.params["id"]!,
    { ...defined(body), ...(bodyLines !== undefined ? { lines: lines(bodyLines) } : {}) },
    auditContextFrom(req),
  );
  res.json(bill);
}

export async function remove(req: Request, res: Response): Promise<void> {
  await service.deleteBill(req.tenantId!, req.params["id"]!, auditContextFrom(req));
  res.status(204).end();
}

export async function post(req: Request, res: Response): Promise<void> {
  res.json(await service.postBill(req.tenantId!, req.params["id"]!, auditContextFrom(req)));
}

export async function cancel(req: Request, res: Response): Promise<void> {
  const body = cancelInvoiceSchema.parse(req.body);
  res.json(await service.cancelBill(req.tenantId!, req.params["id"]!, body.reason, auditContextFrom(req)));
}

export async function pay(req: Request, res: Response): Promise<void> {
  const body = recordBillPaymentSchema.parse(req.body);
  const bill = await service.payBill(
    { ...defined(body), tenantId: req.tenantId!, billId: req.params["id"]! },
    auditContextFrom(req),
  );
  res.status(201).json(bill);
}

export async function createDebitNote(req: Request, res: Response): Promise<void> {
  const { lines: bodyLines, ...body } = createDebitNoteSchema.parse(req.body);
  const note = await service.createDebitNote(
    { ...defined(body), lines: lines(bodyLines), tenantId: req.tenantId!, billId: req.params["id"]! },
    auditContextFrom(req),
  );
  res.status(201).json(note);
}
