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
import type {
  CustomerLedgerJournalRow,
  CustomerRow,
  CustomerWithActivityRow,
  ListCustomersFilters,
  UpdateCustomerInput,
} from "./repository.js";

export interface CreateCustomerRequest {
  readonly tenantId: string;
  readonly name: string;
  readonly phone?: string;
  readonly email?: string;
  readonly address?: string;
  readonly tags?: string[];
  readonly taxIdentifier?: string;
  readonly paymentTermsDays?: number;
  readonly currency?: string;
  readonly creditLimitMinor?: number;
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
      ...(request.taxIdentifier !== undefined ? { taxIdentifier: request.taxIdentifier } : {}),
      ...(request.paymentTermsDays !== undefined ? { paymentTermsDays: request.paymentTermsDays } : {}),
      ...(request.currency !== undefined ? { currency: request.currency } : {}),
      ...(request.creditLimitMinor !== undefined ? { creditLimitMinor: request.creditLimitMinor } : {}),
    },
    audit,
  );
}

export async function listCustomers(tenantId: string, filters: ListCustomersFilters = {}): Promise<CustomerWithActivityRow[]> {
  return repository.listCustomers(tenantId, filters);
}

export async function getCustomer(tenantId: string, customerId: string, asOf?: string): Promise<CustomerWithActivityRow> {
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

export async function updateCustomer(
  tenantId: string,
  customerId: string,
  request: UpdateCustomerInput,
  audit: AuditContext,
): Promise<CustomerRow> {
  const customer = await repository.updateCustomer(tenantId, customerId, request, audit);
  if (!customer) {
    throw new DomainError("CUSTOMER_NOT_FOUND", `Customer ${customerId} not found`);
  }
  return customer;
}

/** The customer's POSTED journals in [from, to], oldest first (customerLedger builds on this). */
export async function listLedgerJournals(
  tenantId: string,
  customerId: string,
  from?: string,
  to?: string,
): Promise<CustomerLedgerJournalRow[]> {
  return repository.listLedgerJournals(tenantId, customerId, from, to);
}

/** The customer's balance from POSTED journals dated before `date`. */
export async function balanceBefore(tenantId: string, customerId: string, date: string): Promise<number> {
  return repository.balanceBefore(tenantId, customerId, date);
}
