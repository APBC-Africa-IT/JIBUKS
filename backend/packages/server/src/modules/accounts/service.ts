/**
 * Accounts service -- the public interface of this module.
 *
 * Other modules (e.g. the future journals module, building a
 * PostingContext for @jibuks/ledger) import from HERE, never from
 * repository.ts directly. This is the "explicit interface" AD-01 requires
 * for module boundaries to mean anything.
 */

import {
  DomainError,
  SYSTEM_ACCOUNT_KEYS,
  SYSTEM_ACCOUNT_TYPES,
  isCurrencyCode,
  type AccountType,
  type AssignableSystemAccountKey,
} from "@jibuks/domain";
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

const SYSTEM_ACCOUNT_NAMES: Readonly<Record<SystemAccountKey, string>> = {
  MPESA: "M-Pesa",
  OPENING_BALANCE: "Opening Balance Equity",
  RECEIVABLE: "Accounts Receivable",
  PAYABLE: "Accounts Payable",
  VAT_INPUT: "VAT Recoverable (input VAT)",
  VAT_OUTPUT: "VAT Payable (output VAT)",
  CASH: "Cash",
  BANK: "Bank",
};

/**
 * The account carrying `systemKey`; 422 SYSTEM_ACCOUNT_MISSING if none.
 * Never created on the fly: a tenant without the key usually has the
 * account under another name or code, and a second Accounts Receivable
 * would split its balance. `field` names the request field that would
 * have avoided the lookup.
 */
export async function requireSystemAccount(tenantId: string, systemKey: SystemAccountKey, field: string): Promise<AccountRow> {
  const account = await repository.findAccountBySystemKey(tenantId, systemKey);
  if (!account) {
    throw new DomainError(
      "SYSTEM_ACCOUNT_MISSING",
      `No account is marked as this business's ${SYSTEM_ACCOUNT_NAMES[systemKey]}. Pass ${field}, or mark the account with PATCH /accounts/{id} {"systemKey": "${systemKey}"}`,
      [{ path: field, message: `Required: no ${systemKey} account is set` }],
    );
  }
  return account;
}

/** Every system key with the id of the account carrying it, or null -- for GET /tenant. */
export async function systemAccountIds(tenantId: string): Promise<Record<SystemAccountKey, string | null>> {
  const tagged = await repository.listSystemAccounts(tenantId);
  const ids = Object.fromEntries(SYSTEM_ACCOUNT_KEYS.map((key) => [key, null])) as Record<SystemAccountKey, string | null>;
  for (const account of tagged) {
    ids[account.system_key!] = account.id;
  }
  return ids;
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
  /** Make this the account for that purpose, taking the key off whichever account had it. */
  readonly systemKey?: AssignableSystemAccountKey;
}

/**
 * FR-COA-03/04. A parent must exist, have the same type, and not be the
 * account itself or one of its descendants. Type and currency never change.
 * A system key needs an active, postable account of the key's type.
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
  if (request.systemKey !== undefined) {
    const expected = SYSTEM_ACCOUNT_TYPES[request.systemKey];
    if (account.type !== expected) {
      throw new DomainError(
        "ACCOUNT_NOT_POSTABLE",
        `${request.systemKey} needs an ${expected} account; ${account.code} is ${account.type}`,
        [{ path: "systemKey", message: `Needs an ${expected} account` }],
      );
    }
    if (!account.is_active) {
      throw new DomainError("ACCOUNT_INACTIVE", `Account ${account.code} is inactive`);
    }
    if (!account.is_postable) {
      throw new DomainError("ACCOUNT_NOT_POSTABLE", `Account ${account.code} is a header account and can't be posted to`);
    }
    if (account.system_key !== null && account.system_key !== request.systemKey) {
      throw new DomainError(
        "ACCOUNT_NOT_POSTABLE",
        `Account ${account.code} is already this business's ${account.system_key} account`,
        [{ path: "systemKey", message: `Already ${account.system_key}` }],
      );
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