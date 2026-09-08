/**
 * Suppliers service -- the public interface of this module.
 *
 * Unlike accounts, suppliers never enter @jibuks/ledger's PostingContext
 * directly -- a journal line only carries a supplierId as an optional
 * dimensional tag (see journals/service.ts).
 */

import { DomainError } from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import * as repository from "./repository.js";
import type { SupplierRow, SupplierWithBalanceRow } from "./repository.js";

export interface CreateSupplierRequest {
  readonly tenantId: string;
  readonly name: string;
  readonly phone?: string;
  readonly email?: string;
  readonly address?: string;
  readonly tags?: string[];
}

export async function createSupplier(request: CreateSupplierRequest, audit: AuditContext): Promise<SupplierRow> {
  return repository.createSupplier(
    {
      tenantId: request.tenantId,
      name: request.name,
      ...(request.phone !== undefined ? { phone: request.phone } : {}),
      ...(request.email !== undefined ? { email: request.email } : {}),
      ...(request.address !== undefined ? { address: request.address } : {}),
      ...(request.tags !== undefined ? { tags: request.tags } : {}),
    },
    audit,
  );
}

export async function listSuppliers(tenantId: string, asOf?: string): Promise<SupplierWithBalanceRow[]> {
  return repository.listSuppliers(tenantId, asOf);
}

export async function getSupplier(tenantId: string, supplierId: string, asOf?: string): Promise<SupplierWithBalanceRow> {
  const supplier = await repository.getSupplierById(tenantId, supplierId, asOf);
  if (!supplier) {
    throw new DomainError("SUPPLIER_NOT_FOUND", `Supplier ${supplierId} not found`);
  }
  return supplier;
}

export async function deactivateSupplier(tenantId: string, supplierId: string, audit: AuditContext): Promise<SupplierRow> {
  const supplier = await repository.deactivateSupplier(tenantId, supplierId, audit);
  if (!supplier) {
    throw new DomainError("SUPPLIER_NOT_FOUND", `Supplier ${supplierId} not found`);
  }
  return supplier;
}

export async function reactivateSupplier(tenantId: string, supplierId: string, audit: AuditContext): Promise<SupplierRow> {
  const supplier = await repository.reactivateSupplier(tenantId, supplierId, audit);
  if (!supplier) {
    throw new DomainError("SUPPLIER_NOT_FOUND", `Supplier ${supplierId} not found`);
  }
  return supplier;
}
