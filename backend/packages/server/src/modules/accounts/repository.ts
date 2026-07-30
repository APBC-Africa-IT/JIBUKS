/**
 * Accounts repository.
 *
 * The ONLY file permitted to write raw SQL against the `accounts` table
 * (AD-02: "a module MUST own its tables exclusively"). Every write goes
 * through recordAuditLog inside the SAME transaction, per FR-AUD-01.
 *
 * Returns plain row shapes -- mapping into @jibuks/ledger's AccountSnapshot
 * or any other domain shape is the service layer's job, not this one.
 */

import { randomUUID } from "node:crypto";
import { recordAuditLog, withTenant, readAsTenant, type AuditContext } from "@jibuks/db";

export interface AccountRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly parent_account_id: string | null;
  readonly code: string;
  readonly name: string;
  readonly type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
  readonly currency: string | null;
  readonly is_active: boolean;
  readonly is_postable: boolean;
  readonly tags: string[];
  readonly created_at: string;
}

export interface CreateAccountInput {
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountRow["type"];
  readonly parentAccountId?: string;
  readonly currency?: string;
  readonly tags?: string[];
  readonly isPostable?: boolean;
}

export async function createAccount(input: CreateAccountInput, audit: AuditContext): Promise<AccountRow> {
  return withTenant(input.tenantId, async (client) => {
    const id = randomUUID();
    const result = await client.query<AccountRow>(
      `INSERT INTO accounts (id, tenant_id, parent_account_id, code, name, type, currency, is_postable, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        id,
        input.tenantId,
        input.parentAccountId ?? null,
        input.code,
        input.name,
        input.type,
        input.currency ?? null,
        input.isPostable ?? true,
        input.tags ?? [],
      ],
    );

    const account = result.rows[0]!;

    await recordAuditLog(client, {
      tenantId: input.tenantId,
      action: "CREATE",
      entityType: "account",
      entityId: account.id,
      afterState: account,
      context: audit,
    });

    return account;
  });
}

export async function listAccounts(tenantId: string): Promise<AccountRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<AccountRow>(
      `SELECT * FROM accounts ORDER BY code ASC`,
    );
    return result.rows;
  });
}

export async function getAccountById(tenantId: string, accountId: string): Promise<AccountRow | null> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<AccountRow>(`SELECT * FROM accounts WHERE id = $1`, [accountId]);
    return result.rows[0] ?? null;
  });
}

/** FR-COA-03: accounts are never deleted, only deactivated. */
export async function deactivateAccount(
  tenantId: string,
  accountId: string,
  audit: AuditContext,
): Promise<AccountRow | null> {
  return withTenant(tenantId, async (client) => {
    const before = await client.query<AccountRow>(`SELECT * FROM accounts WHERE id = $1`, [accountId]);
    if (before.rows.length === 0) {
      return null;
    }

    const result = await client.query<AccountRow>(
      `UPDATE accounts SET is_active = false WHERE id = $1 RETURNING *`,
      [accountId],
    );
    const account = result.rows[0]!;

    await recordAuditLog(client, {
      tenantId,
      action: "UPDATE",
      entityType: "account",
      entityId: account.id,
      beforeState: before.rows[0],
      afterState: account,
      context: audit,
    });

    return account;
  });
}