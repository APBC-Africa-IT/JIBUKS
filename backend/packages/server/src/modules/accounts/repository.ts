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

/** An AccountRow plus its computed balance -- what GET /accounts and GET
 * /accounts/{id} return. Net of POSTED journal_lines against the account,
 * on its natural side (debit for ASSET/EXPENSE, credit for
 * LIABILITY/EQUITY/INCOME), as of `asOf` if given, otherwise as of now.
 * bigint sum comes back from pg as a string. */
export interface AccountWithBalanceRow extends AccountRow {
  readonly balance_minor: string;
}

/**
 * The join shared by listAccounts/getAccountById: sums POSTED journal_lines
 * per account, signed onto each account's natural side. DRAFT/PENDING_APPROVAL
 * journals never affect a balance -- only POSTED ones are real ledger effects
 * (FR-ACC-02). In BALANCE_EXPR, j.id IS NULL covers both "no lines at all"
 * and "lines whose journal didn't match the POSTED/asOf filter" -- either
 * way, they contribute 0.
 */
function balanceJoin(asOfParamIndex: number | null): string {
  const asOfClause = asOfParamIndex !== null ? ` AND j.date <= $${asOfParamIndex}` : "";
  return `
    LEFT JOIN journal_lines jl ON jl.account_id = a.id
    LEFT JOIN journals j ON j.id = jl.journal_id AND j.status = 'POSTED'${asOfClause}
  `;
}

const BALANCE_EXPR = `
  COALESCE(SUM(
    CASE WHEN j.id IS NULL THEN 0
         WHEN a.type IN ('ASSET', 'EXPENSE') THEN jl.debit_minor - jl.credit_minor
         ELSE jl.credit_minor - jl.debit_minor
    END
  ), 0)::text AS balance_minor
`;

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

export async function listAccounts(tenantId: string, asOf?: string): Promise<AccountWithBalanceRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const params: unknown[] = [];
    let asOfParamIndex: number | null = null;
    if (asOf) {
      params.push(asOf);
      asOfParamIndex = params.length;
    }

    const result = await client.query<AccountWithBalanceRow>(
      `SELECT a.*, ${BALANCE_EXPR}
       FROM accounts a
       ${balanceJoin(asOfParamIndex)}
       GROUP BY a.id
       ORDER BY a.code ASC`,
      params,
    );
    return result.rows;
  });
}

export async function getAccountById(
  tenantId: string,
  accountId: string,
  asOf?: string,
): Promise<AccountWithBalanceRow | null> {
  return readAsTenant(tenantId, async (client) => {
    const params: unknown[] = [accountId];
    let asOfParamIndex: number | null = null;
    if (asOf) {
      params.push(asOf);
      asOfParamIndex = params.length;
    }

    const result = await client.query<AccountWithBalanceRow>(
      `SELECT a.*, ${BALANCE_EXPR}
       FROM accounts a
       ${balanceJoin(asOfParamIndex)}
       WHERE a.id = $1
       GROUP BY a.id`,
      params,
    );
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

export async function reactivateAccount(
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
      `UPDATE accounts SET is_active = true WHERE id = $1 RETURNING *`,
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