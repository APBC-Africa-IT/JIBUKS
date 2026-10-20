/**
 * Invoices controllers -- HTTP layer only.
 */

import type { Request, Response } from "express";
import {
  DomainError,
  cancelInvoiceSchema,
  convertProformaSchema,
  createCreditNoteSchema,
  createInvoiceSchema,
  estimateResponseSchema,
  issueInvoiceSchema,
  listInvoicesQuerySchema,
  recordInvoicePaymentSchema,
  updateInvoiceSchema,
} from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import { loadPermissions } from "../../middleware/requirePermission.js";
import * as customerPaymentsService from "../customerPayments/service.js";
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
  const { issue, overrideCreditLimit, ...body } = createInvoiceSchema.parse(req.body);
  const request = { ...defined(body), lines: lines(body), tenantId: req.tenantId! };
  if (!issue) {
    res.status(201).json(await service.createInvoice(request, auditContextFrom(req)));
    return;
  }
  const permissions = await loadPermissions(req);
  if (!permissions.has("invoices:issue")) {
    throw new DomainError("FORBIDDEN", 'issue: true requires the "invoices:issue" permission');
  }
  const invoice = await service.createAndIssueInvoice(
    request,
    { overrideCreditLimit, mayOverrideCreditLimit: permissions.has("invoices:override_credit_limit") },
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
      estimateStatus: query.estimate_status,
      q: query.q,
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

/** A payment against one invoice: recorded as a customer payment applied to it in full. */
export async function recordPayment(req: Request, res: Response): Promise<void> {
  const body = recordInvoicePaymentSchema.parse(req.body);
  const invoiceId = req.params["id"]!;
  const invoice = await service.getInvoiceRow(req.tenantId!, invoiceId);
  await customerPaymentsService.receivePayment(
    {
      tenantId: req.tenantId!,
      clientUuid: body.clientUuid,
      customerId: invoice.customer_id!,
      amountMinor: body.amountMinor,
      date: body.date,
      method: body.method,
      receivedAccountId: body.receivedAccountId,
      reference: body.reference,
      allocations: [{ invoiceId, amountMinor: body.amountMinor }],
    },
    auditContextFrom(req),
  );
  res.status(201).json(await service.getInvoice(req.tenantId!, invoiceId));
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

/** The customer's answer to an estimate (pro-forma). */
export async function accept(req: Request, res: Response): Promise<void> {
  const { note } = estimateResponseSchema.parse(req.body ?? {});
  res.json(await service.respondToEstimate(req.tenantId!, req.params["id"]!, "ACCEPTED", note, auditContextFrom(req)));
}

export async function decline(req: Request, res: Response): Promise<void> {
  const { note } = estimateResponseSchema.parse(req.body ?? {});
  res.json(await service.respondToEstimate(req.tenantId!, req.params["id"]!, "DECLINED", note, auditContextFrom(req)));
}
