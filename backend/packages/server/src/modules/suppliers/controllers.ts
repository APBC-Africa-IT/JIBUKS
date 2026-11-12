/**
 * Suppliers controllers -- HTTP layer only. Parse request, call service,
 * shape response. All business logic lives in service.ts.
 */

import type { Request, Response } from "express";
import {
  createSupplierSchema,
  daysPastDue,
  DomainError,
  listSuppliersQuerySchema,
  partyBalanceQuerySchema,
  supplierTypeSchema,
  updateSupplierSchema,
} from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import { loadPermissions } from "../../middleware/requirePermission.js";
import * as documents from "../invoices/documents.js";
import { AP } from "../invoices/documents.js";
import * as openingBalancesService from "../openingBalances/service.js";
import { todayInNairobi } from "../periods/service.js";
import type { SupplierWithBalanceRow } from "./repository.js";
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
  const { openingBalance, ...body } = createSupplierSchema.parse(req.body);
  // Changes the business's opening balances, so it needs what PUT /opening-balances needs.
  if (openingBalance && !(await loadPermissions(req)).has("opening_balances:manage")) {
    throw new DomainError("FORBIDDEN", 'An opening balance requires the "opening_balances:manage" permission');
  }
  const request: service.CreateSupplierRequest = {
    tenantId: req.tenantId!,
    name: body.name,
    ...(body.phone ? { phone: body.phone } : {}),
    ...(body.email ? { email: body.email } : {}),
    ...(body.address ? { address: body.address } : {}),
    tags: body.tags,
    ...(body.taxIdentifier !== undefined ? { taxIdentifier: body.taxIdentifier } : {}),
    ...(body.paymentTermsDays !== undefined ? { paymentTermsDays: body.paymentTermsDays } : {}),
    ...(body.currency !== undefined ? { currency: body.currency } : {}),
    ...(body.supplierTypeId !== undefined ? { supplierTypeId: body.supplierTypeId } : {}),
    ...(body.city !== undefined ? { city: body.city } : {}),
    ...(body.country !== undefined ? { country: body.country } : {}),
    ...(body.postalCode !== undefined ? { postalCode: body.postalCode } : {}),
    vatRegistered: body.vatRegistered,
    ...(body.defaultTaxRateBps !== undefined ? { defaultTaxRateBps: body.defaultTaxRateBps } : {}),
    ...(body.preferredPaymentMethod !== undefined ? { preferredPaymentMethod: body.preferredPaymentMethod } : {}),
    ...(body.bankName !== undefined ? { bankName: body.bankName } : {}),
    ...(body.bankAccountNumber !== undefined ? { bankAccountNumber: body.bankAccountNumber } : {}),
    ...(body.mpesaPhone !== undefined ? { mpesaPhone: body.mpesaPhone } : {}),
    ...(body.mpesaPaybillTill !== undefined ? { mpesaPaybillTill: body.mpesaPaybillTill } : {}),
    isActive: body.isActive,
  };
  const created = openingBalance
    ? await openingBalancesService.createSupplierWithOpeningBalance(request, openingBalance, auditContextFrom(req))
    : await service.createSupplier(request, auditContextFrom(req));
  const supplier = await service.getSupplier(req.tenantId!, created.id);
  const [withStatus] = await withPaymentStatus(req.tenantId!, [supplier], todayInNairobi(), supplier.id);
  res.status(201).json(withStatus);
}

/** OVERDUE: a posted bill is past due. DUE: owed, nothing past due. CREDIT: the supplier owes the business. SETTLED: nothing either way. */
type PaymentStatus = "OVERDUE" | "DUE" | "CREDIT" | "SETTLED";

/** Adds the list's "(Overdue)" / "(Due)" tag: what is past due on posted bills at `asOf`, and the status it gives. */
async function withPaymentStatus(tenantId: string, suppliers: SupplierWithBalanceRow[], asOf: string, supplierId?: string) {
  const open = await documents.listOpenAsOf(AP, tenantId, asOf, supplierId);
  const overdue = new Map<string, number>();
  for (const bill of open) {
    if (daysPastDue(bill.due_date ?? bill.issue_date, asOf) > 0) {
      overdue.set(bill.party_id, (overdue.get(bill.party_id) ?? 0) + Number(bill.open_minor));
    }
  }
  return suppliers.map((supplier) => {
    const overdueMinor = overdue.get(supplier.id) ?? 0;
    const balance = Number(supplier.balance_minor);
    const paymentStatus: PaymentStatus = overdueMinor > 0 ? "OVERDUE" : balance > 0 ? "DUE" : balance < 0 ? "CREDIT" : "SETTLED";
    return { ...supplier, overdue_minor: String(overdueMinor), payment_status: paymentStatus };
  });
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = listSuppliersQuerySchema.parse(req.query);
  const suppliers = await service.listSuppliers(req.tenantId!, {
    asOf: query.as_of,
    q: query.q,
    supplierTypeId: query.supplier_type_id,
  });
  res.json({ data: await withPaymentStatus(req.tenantId!, suppliers, query.as_of ?? todayInNairobi()) });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const { as_of } = partyBalanceQuerySchema.parse(req.query);
  const supplier = await service.getSupplier(req.tenantId!, req.params["id"]!, as_of);
  const [withStatus] = await withPaymentStatus(req.tenantId!, [supplier], as_of ?? todayInNairobi(), supplier.id);
  res.json(withStatus);
}

export async function update(req: Request, res: Response): Promise<void> {
  const body = updateSupplierSchema.parse(req.body);
  const supplier = await service.updateSupplier(req.tenantId!, req.params["id"]!, body, auditContextFrom(req));
  res.json(supplier);
}

export async function deactivate(req: Request, res: Response): Promise<void> {
  const supplier = await service.deactivateSupplier(req.tenantId!, req.params["id"]!, auditContextFrom(req));
  res.json(supplier);
}

export async function reactivate(req: Request, res: Response): Promise<void> {
  const supplier = await service.reactivateSupplier(req.tenantId!, req.params["id"]!, auditContextFrom(req));
  res.json(supplier);
}

export async function listTypes(req: Request, res: Response): Promise<void> {
  res.json({ data: await service.listSupplierTypes(req.tenantId!) });
}

export async function createType(req: Request, res: Response): Promise<void> {
  const { name } = supplierTypeSchema.parse(req.body);
  res.status(201).json(await service.createSupplierType(req.tenantId!, name, auditContextFrom(req)));
}

export async function renameType(req: Request, res: Response): Promise<void> {
  const { name } = supplierTypeSchema.parse(req.body);
  res.json(await service.renameSupplierType(req.tenantId!, req.params["id"]!, name, auditContextFrom(req)));
}
