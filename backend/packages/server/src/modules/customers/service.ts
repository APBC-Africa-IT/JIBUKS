/**
 * Customers service -- the public interface of this module.
 *
 * Unlike accounts, customers never enter @jibuks/ledger's PostingContext
 * directly -- a journal line only carries a customerId as an optional
 * dimensional tag (see journals/service.ts), so there is no
 * loadCustomerSnapshots equivalent here.
 */

import { DomainError } from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import * as repository from "./repository.js";
import type { CustomerRow, CustomerWithBalanceRow } from "./repository.js";

export interface CreateCustomerRequest {
  readonly tenantId: string;
  readonly name: string;
  readonly phone?: string;
  readonly email?: string;
  readonly address?: string;
  readonly tags?: string[];
}

export async function createCustomer(request: CreateCustomerRequest, audit: AuditContext): Promise<CustomerRow> {
  return repository.createCustomer(
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

export async function listCustomers(tenantId: string, asOf?: string): Promise<CustomerWithBalanceRow[]> {
  return repository.listCustomers(tenantId, asOf);
}

export async function getCustomer(tenantId: string, customerId: string, asOf?: string): Promise<CustomerWithBalanceRow> {
  const customer = await repository.getCustomerById(tenantId, customerId, asOf);
  if (!customer) {
    throw new DomainError("CUSTOMER_NOT_FOUND", `Customer ${customerId} not found`);
  }
  return customer;
}

export async function deactivateCustomer(tenantId: string, customerId: string, audit: AuditContext): Promise<CustomerRow> {
  const customer = await repository.deactivateCustomer(tenantId, customerId, audit);
  if (!customer) {
    throw new DomainError("CUSTOMER_NOT_FOUND", `Customer ${customerId} not found`);
  }
  return customer;
}

export async function reactivateCustomer(tenantId: string, customerId: string, audit: AuditContext): Promise<CustomerRow> {
  const customer = await repository.reactivateCustomer(tenantId, customerId, audit);
  if (!customer) {
    throw new DomainError("CUSTOMER_NOT_FOUND", `Customer ${customerId} not found`);
  }
  return customer;
}
