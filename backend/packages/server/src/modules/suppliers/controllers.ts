/**
 * Suppliers controllers -- HTTP layer only. Parse request, call service,
 * shape response. All business logic lives in service.ts.
 */

import type { Request, Response } from "express";
import { createSupplierSchema, DomainError, supplierTypeSchema, updateSupplierSchema } from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import { loadPermissions } from "../../middleware/requirePermission.js";
import * as openingBalancesService from "../openingBalances/service.js";
import * as supplierLedgerService from "../supplierLedger/service.js";
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
  res.status(201).json(await supplierLedgerService.getSupplierEntry(req.tenantId!, created.id));
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
