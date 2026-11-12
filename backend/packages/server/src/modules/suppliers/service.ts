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
import type {
  CreateSupplierInput,
  ListSuppliersFilters,
  SupplierRow,
  SupplierTypeRow,
  SupplierWithBalanceRow,
  TxClient,
  UpdateSupplierInput,
} from "./repository.js";

export type CreateSupplierRequest = CreateSupplierInput;

export async function createSupplier(request: CreateSupplierRequest, audit: AuditContext): Promise<SupplierRow> {
  return repository.createSupplier(request, audit);
}

/** Creates the supplier inside the caller's transaction (opening balances posts its opening journal in the same one). */
export async function insertSupplier(client: TxClient, request: CreateSupplierRequest, audit: AuditContext): Promise<SupplierRow> {
  return repository.insertSupplier(client, request, audit);
}

export async function listSuppliers(tenantId: string, filters: ListSuppliersFilters = {}): Promise<SupplierWithBalanceRow[]> {
  return repository.listSuppliers(tenantId, filters);
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

export async function updateSupplier(
  tenantId: string,
  supplierId: string,
  request: UpdateSupplierInput,
  audit: AuditContext,
): Promise<SupplierRow> {
  const supplier = await repository.updateSupplier(tenantId, supplierId, request, audit);
  if (!supplier) {
    throw new DomainError("SUPPLIER_NOT_FOUND", `Supplier ${supplierId} not found`);
  }
  return supplier;
}

export async function listSupplierTypes(tenantId: string): Promise<SupplierTypeRow[]> {
  return repository.listSupplierTypes(tenantId);
}

/** A new business's starting Supplier Type list (onboarding). */
export async function seedDefaultSupplierTypes(tenantId: string): Promise<void> {
  return repository.seedDefaultSupplierTypes(tenantId);
}

export async function createSupplierType(tenantId: string, name: string, audit: AuditContext): Promise<SupplierTypeRow> {
  return repository.createSupplierType(tenantId, name, audit);
}

export async function renameSupplierType(
  tenantId: string,
  supplierTypeId: string,
  name: string,
  audit: AuditContext,
): Promise<SupplierTypeRow> {
  const type = await repository.renameSupplierType(tenantId, supplierTypeId, name, audit);
  if (!type) {
    throw new DomainError("SUPPLIER_TYPE_NOT_FOUND", `Supplier type ${supplierTypeId} not found`);
  }
  return type;
}
