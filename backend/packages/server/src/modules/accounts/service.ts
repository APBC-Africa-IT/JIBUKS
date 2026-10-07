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
import type { AccountRow, AccountWithBalanceRow, SystemAccountKey } from "./repository.js";

/** The account M-Pesa collections are received into. Starter code 1020;
 * if a business already uses 1020 for something else, the next free code. */
const MPESA_ACCOUNT = {
  name: "M-Pesa",
  type: "ASSET",
  codes: Array.from({ length: 80 }, (_, i) => String(1020 + i)),
} as const;

/** Absorbs the difference in the opening journal (FR-ACC-04). Starter code 3900. */
const OPENING_BALANCE_ACCOUNT = {
  name: "Opening Balance Equity",
  type: "EQUITY",
  codes: Array.from({ length: 100 }, (_, i) => String(3900 + i)),
} as const;

export interface CreateAccountRequest {
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly parentAccountId?: string;
  readonly currency?: string;
  readonly tags?: string[];
  /** Internal only (onboarding); never taken from a request body. */
  readonly systemKey?: SystemAccountKey;
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
      ...(request.systemKey !== undefined ? { systemKey: request.systemKey } : {}),
    },
    audit,
  );
}

/**
 * The tenant's M-Pesa account (system_key 'MPESA'), created on first use.
 * Found by its system key, never by code, so a business that used code
 * 1020 for something else before it became the M-Pesa starter account
 * keeps that account untouched.
 */
export async function getOrCreateMpesaAccount(tenantId: string, audit: AuditContext): Promise<AccountRow> {
  return (
    (await repository.findAccountBySystemKey(tenantId, "MPESA")) ??
    repository.getOrCreateSystemAccount(tenantId, "MPESA", MPESA_ACCOUNT, audit)
  );
}

/** The account carrying `systemKey`, if the tenant has one yet. */
export async function findSystemAccount(tenantId: string, systemKey: SystemAccountKey): Promise<AccountRow | null> {
  return repository.findAccountBySystemKey(tenantId, systemKey);
}

/** The tenant's Opening Balance Equity account (system_key 'OPENING_BALANCE'), created on first use. */
export async function getOrCreateOpeningBalanceAccount(tenantId: string, audit: AuditContext): Promise<AccountRow> {
  return (
    (await repository.findAccountBySystemKey(tenantId, "OPENING_BALANCE")) ??
    repository.getOrCreateSystemAccount(tenantId, "OPENING_BALANCE", OPENING_BALANCE_ACCOUNT, audit)
  );
}

export interface UpdateAccountRequest {
  readonly code?: string;
  readonly name?: string;
  readonly tags?: string[];
  readonly parentAccountId?: string | null;
}

/**
 * FR-COA-03/04. A parent must exist, have the same type, and not be the
 * account itself or one of its descendants. Type and currency never change.
 */
export async function updateAccount(
  tenantId: string,
  accountId: string,
  request: UpdateAccountRequest,
  audit: AuditContext,
): Promise<AccountRow> {
  const account = await getAccount(tenantId, accountId);
  if (request.parentAccountId) {
    const accounts = await repository.listAccounts(tenantId);
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const parent = byId.get(request.parentAccountId);
    if (!parent) {
      throw new DomainError("ACCOUNT_NOT_FOUND", `Parent account ${request.parentAccountId} not found`);
    }
    if (parent.type !== account.type) {
      throw new DomainError(
        "ACCOUNT_NOT_POSTABLE",
        `Parent account ${parent.code} is type ${parent.type}, cannot have a ${account.type} child`,
      );
    }
    for (let at: AccountRow | undefined = parent; at; at = at.parent_account_id ? byId.get(at.parent_account_id) : undefined) {
      if (at.id === accountId) {
        throw new DomainError("ACCOUNT_NOT_POSTABLE", "An account can't be placed under itself or one of its own sub-accounts");
      }
    }
  }
  const updated = await repository.updateAccount(tenantId, accountId, request, audit);
  if (!updated) {
    throw new DomainError("ACCOUNT_NOT_FOUND", `Account ${accountId} not found`);
  }
  return updated;
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