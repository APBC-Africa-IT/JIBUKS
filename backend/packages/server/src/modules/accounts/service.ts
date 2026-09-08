/**
 * Accounts service -- the public interface of this module.
 *
 * Other modules (e.g. the future journals module, building a
 * PostingContext for @jibuks/ledger) import from HERE, never from
 * repository.ts directly. This is the "explicit interface" AD-01 requires
 * for module boundaries to mean anything.
 */

import { DomainError, isCurrencyCode, type AccountType } from "@jibuks/domain";
import type { AccountSnapshot } from "@jibuks/ledger";
import type { AuditContext } from "@jibuks/db";
import * as repository from "./repository.js";
import type { AccountRow, AccountWithBalanceRow } from "./repository.js";

export interface CreateAccountRequest {
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly parentAccountId?: string;
  readonly currency?: string;
  readonly tags?: string[];
}

export async function createAccount(request: CreateAccountRequest, audit: AuditContext): Promise<AccountRow> {
  if (request.parentAccountId) {
    const parent = await repository.getAccountById(request.tenantId, request.parentAccountId);
    if (!parent) {
      throw new DomainError("ACCOUNT_NOT_FOUND", `Parent account ${request.parentAccountId} not found`);
    }
    if (parent.type !== request.type) {
      throw new DomainError(
        "ACCOUNT_NOT_POSTABLE",
        `Parent account ${parent.code} is type ${parent.type}, cannot have a ${request.type} child`,
      );
    }
  }

  return repository.createAccount(
    {
      tenantId: request.tenantId,
      code: request.code,
      name: request.name,
      type: request.type,
      ...(request.parentAccountId !== undefined ? { parentAccountId: request.parentAccountId } : {}),
      ...(request.currency !== undefined ? { currency: request.currency } : {}),
      ...(request.tags !== undefined ? { tags: request.tags } : {}),
    },
    audit,
  );
}

export async function listAccounts(tenantId: string, asOf?: string): Promise<AccountWithBalanceRow[]> {
  return repository.listAccounts(tenantId, asOf);
}

export async function getAccount(tenantId: string, accountId: string, asOf?: string): Promise<AccountWithBalanceRow> {
  const account = await repository.getAccountById(tenantId, accountId, asOf);
  if (!account) {
    throw new DomainError("ACCOUNT_NOT_FOUND", `Account ${accountId} not found`);
  }
  return account;
}

export async function deactivateAccount(
  tenantId: string,
  accountId: string,
  audit: AuditContext,
): Promise<AccountRow> {
  const account = await repository.deactivateAccount(tenantId, accountId, audit);
  if (!account) {
    throw new DomainError("ACCOUNT_NOT_FOUND", `Account ${accountId} not found`);
  }
  return account;
}

export async function reactivateAccount(
  tenantId: string,
  accountId: string,
  audit: AuditContext,
): Promise<AccountRow> {
  const account = await repository.reactivateAccount(tenantId, accountId, audit);
  if (!account) {
    throw new DomainError("ACCOUNT_NOT_FOUND", `Account ${accountId} not found`);
  }
  return account;
}

/**
 * Load account snapshots for use by @jibuks/ledger's PostingContext.
 * This is exactly the "other modules call the service, not the repository"
 * pattern -- the future journals module will call this function.
 */
export async function loadAccountSnapshots(tenantId: string): Promise<Map<string, AccountSnapshot>> {
  const rows = await repository.listAccounts(tenantId);
  const map = new Map<string, AccountSnapshot>();
  for (const row of rows) {
    map.set(row.id, {
      id: row.id,
      tenantId: row.tenant_id,
      code: row.code,
      type: row.type,
      isActive: row.is_active,
      isPostable: row.is_postable,
      currency: isCurrencyCode(row.currency) ? row.currency : null,
    });
  }
  return map;
}