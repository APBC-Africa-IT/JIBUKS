/**
 * Invoices controllers -- HTTP layer only.
 */

import type { Request, Response } from "express";
import {
  cancelInvoiceSchema,
  convertProformaSchema,
  createCreditNoteSchema,
  createInvoiceSchema,
  issueInvoiceSchema,
  listInvoicesQuerySchema,
  recordInvoicePaymentSchema,
  updateInvoiceSchema,
} from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import { loadPermissions } from "../../middleware/requirePermission.js";
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

function lines(body: { lines: ReadonlyArray<object> }) {
  return body.lines.map((line) => defined(line)) as never;
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = createInvoiceSchema.parse(req.body);
  const invoice = await service.createInvoice(
    { ...defined(body), lines: lines(body), tenantId: req.tenantId! },
    auditContextFrom(req),
  );
  res.status(201).json(invoice);
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = listInvoicesQuerySchema.parse(req.query);
  const page = await service.listInvoices(
    req.tenantId!,
    defined({
      status: query.status,
      kind: query.kind,
      customerId: query.customer_id,
      from: query.from,
      to: query.to,
      limit: query.limit,
      cursor: query.cursor,
    }),
  );
  res.json(page);
}

export async function getOne(req: Request, res: Response): Promise<void> {
  res.json(await service.getInvoice(req.tenantId!, req.params["id"]!));
}

export async function update(req: Request, res: Response): Promise<void> {
  const { lines: bodyLines, ...body } = updateInvoiceSchema.parse(req.body);
  const invoice = await service.updateInvoice(
    req.tenantId!,
    req.params["id"]!,
    { ...defined(body), ...(bodyLines !== undefined ? { lines: lines({ lines: bodyLines }) } : {}) },
    auditContextFrom(req),
  );
  res.json(invoice);
}

export async function remove(req: Request, res: Response): Promise<void> {
  await service.deleteInvoice(req.tenantId!, req.params["id"]!, auditContextFrom(req));
  res.status(204).end();
}

export async function issue(req: Request, res: Response): Promise<void> {
  const body = issueInvoiceSchema.parse(req.body ?? {});
  const permissions = await loadPermissions(req);
  const invoice = await service.issueInvoice(
    req.tenantId!,
    req.params["id"]!,
    {
      overrideCreditLimit: body.overrideCreditLimit,
      mayOverrideCreditLimit: permissions.has("invoices:override_credit_limit"),
    },
    auditContextFrom(req),
  );
  res.json(invoice);
}

export async function cancel(req: Request, res: Response): Promise<void> {
  const body = cancelInvoiceSchema.parse(req.body);
  res.json(await service.cancelInvoice(req.tenantId!, req.params["id"]!, body.reason, auditContextFrom(req)));
}

export async function recordPayment(req: Request, res: Response): Promise<void> {
  const body = recordInvoicePaymentSchema.parse(req.body);
  const invoice = await service.recordPayment(
    { ...defined(body), tenantId: req.tenantId!, invoiceId: req.params["id"]! },
    auditContextFrom(req),
  );
  res.status(201).json(invoice);
}

export async function createCreditNote(req: Request, res: Response): Promise<void> {
  const body = createCreditNoteSchema.parse(req.body);
  const creditNote = await service.createCreditNote(
    { ...defined(body), lines: lines(body), tenantId: req.tenantId!, invoiceId: req.params["id"]! },
    auditContextFrom(req),
  );
  res.status(201).json(creditNote);
}

export async function convert(req: Request, res: Response): Promise<void> {
  const body = convertProformaSchema.parse(req.body);
  const invoice = await service.convertProforma(
    { ...defined(body), tenantId: req.tenantId!, proformaId: req.params["id"]! },
    auditContextFrom(req),
  );
  res.status(201).json(invoice);
}

/** inline: the app can show it or hand it to the phone's share sheet. */
export async function pdf(req: Request, res: Response): Promise<void> {
  const { filename, pdf: body } = await service.getInvoicePdf(req.tenantId!, req.params["id"]!);
  res
    .status(200)
    .type("application/pdf")
    .set("Content-Disposition", `inline; filename="${filename}"`)
    .set("Cache-Control", "private, no-store")
    .send(body);
}
