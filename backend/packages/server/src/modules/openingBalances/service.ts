/**
 * Opening balances (FR-ACC-04): what the business had and owed on the day
 * its books in JiBUks begin, posted as ONE dated opening journal (source
 * OPENING) against Opening Balance Equity.
 *
 * The caller lists balances per account (party-tagged lines give customers
 * and suppliers their opening balances); whatever doesn't balance goes to
 * Opening Balance Equity, so a user never has to make it balance by hand.
 *
 * Sending them again REPLACES them: the current opening journal is reversed
 * -- on its own date, so reports for any date stay right -- and the new one
 * posted, in one transaction. Once the opening journal's period is closed,
 * the opening balances are locked.
 */

import { randomUUID } from "node:crypto";
import { DomainError, type CurrencyCode } from "@jibuks/domain";
import { withTenant, type AuditContext } from "@jibuks/db";
import * as accountsService from "../accounts/service.js";
import * as journalsService from "../journals/service.js";
import type { CreateJournalLineRequest } from "../journals/service.js";
import type { JournalRow, JournalWithLines, TxClient } from "../journals/repository.js";
import * as periodsService from "../periods/service.js";
import * as suppliersService from "../suppliers/service.js";
import type { CreateSupplierRequest } from "../suppliers/service.js";
import type { SupplierRow } from "../suppliers/repository.js";
import * as tenantsService from "../tenants/service.js";

export interface OpeningBalancesView {
  /** The opening date; null if none have been entered. */
  readonly date: string | null;
  /** True once the opening journal's period is closed. */
  readonly locked: boolean;
  readonly opening_balance_account_id: string | null;
  readonly journal: JournalWithLines | null;
}

async function isLocked(tenantId: string, journal: JournalRow): Promise<boolean> {
  const period = await periodsService.getPeriod(tenantId, journal.period_id);
  return period.status !== "OPEN";
}

export async function getOpeningBalances(tenantId: string): Promise<OpeningBalancesView> {
  const active = await journalsService.findActiveJournalBySource(tenantId, "OPENING");
  if (!active) {
    return { date: null, locked: false, opening_balance_account_id: null, journal: null };
  }
  const [journal, obe, locked] = await Promise.all([
    journalsService.getJournal(tenantId, active.id),
    accountsService.findSystemAccount(tenantId, "OPENING_BALANCE"),
    isLocked(tenantId, active),
  ]);
  return { date: active.date, locked, opening_balance_account_id: obe?.id ?? null, journal };
}

export interface SetOpeningBalancesRequest {
  readonly tenantId: string;
  readonly date: string;
  readonly lines: readonly CreateJournalLineRequest[];
}

export async function setOpeningBalances(
  request: SetOpeningBalancesRequest,
  audit: AuditContext,
): Promise<OpeningBalancesView> {
  await replaceOpening(request.tenantId, request.date, request.lines, audit);
  return getOpeningBalances(request.tenantId);
}

interface ReplaceOptions {
  /** Runs first in the posting transaction, e.g. to create the supplier the new lines are tagged with. */
  readonly before?: (client: TxClient) => Promise<void>;
  readonly newSupplierIds?: readonly string[];
}

/** Reverses the current opening journal (if any) and posts one with `lines`, balanced against Opening Balance Equity. */
async function replaceOpening(
  tenantId: string,
  date: string,
  requestLines: readonly CreateJournalLineRequest[],
  audit: AuditContext,
  options: ReplaceOptions = {},
): Promise<void> {
  const tenant = await tenantsService.getTenant(tenantId);
  const obe = await accountsService.getOrCreateOpeningBalanceAccount(tenantId, audit);
  if (requestLines.some((line) => line.accountId === obe.id)) {
    throw new DomainError(
      "JOURNAL_LINE_AMBIGUOUS",
      "Leave Opening Balance Equity out -- the server balances the opening journal against it",
    );
  }

  const difference = requestLines.reduce((sum, line) => sum + line.debitMinor - line.creditMinor, 0);
  const lines: CreateJournalLineRequest[] = [
    ...requestLines,
    ...(difference !== 0
      ? [
          {
            accountId: obe.id,
            debitMinor: difference < 0 ? -difference : 0,
            creditMinor: difference > 0 ? difference : 0,
            narrative: "Opening balance equity",
          },
        ]
      : []),
  ];

  const current = await journalsService.findActiveJournalBySource(tenantId, "OPENING");
  if (current && (await isLocked(tenantId, current))) {
    throw new DomainError(
      "OPENING_BALANCES_LOCKED",
      `The opening balances (${current.date}) are in a closed period; reopen it to change them`,
    );
  }

  const reversal = current
    ? await journalsService.prepareReversal(tenantId, current.id, "Opening balances replaced", audit, current.date)
    : null;
  const opening = await journalsService.prepareJournal(
    {
      tenantId,
      clientUuid: randomUUID(),
      date,
      currency: tenant.base_currency as CurrencyCode,
      description: "Opening balances",
      source: "OPENING",
      lines,
    },
    audit,
    options.newSupplierIds ? { newSupplierIds: options.newSupplierIds } : {},
  );

  await withTenant(tenantId, async (client) => {
    const active = await journalsService.lockActiveJournalBySource(client, tenantId, "OPENING");
    if ((active?.id ?? null) !== (current?.id ?? null)) {
      throw new DomainError("OPENING_BALANCES_LOCKED", "The opening balances changed meanwhile; reload and try again");
    }
    if (options.before) {
      await options.before(client);
    }
    if (reversal) {
      await journalsService.postPreparedJournal(client, reversal, audit);
    }
    await journalsService.postPreparedJournal(client, opening, audit);
  });
}

/** The current opening journal's lines as requests again, without the Opening Balance Equity line the server adds. */
function linesOf(journal: JournalWithLines, obeId: string | null): CreateJournalLineRequest[] {
  return journal.lines
    .filter((line) => line.account_id !== obeId)
    .map((line) => ({
      accountId: line.account_id,
      debitMinor: Number(line.debit_minor),
      creditMinor: Number(line.credit_minor),
      ...(line.narrative !== null ? { narrative: line.narrative } : {}),
      ...(line.project_id !== null ? { projectId: line.project_id } : {}),
      ...(line.department !== null ? { department: line.department } : {}),
      ...(line.customer_id !== null ? { customerId: line.customer_id } : {}),
      ...(line.supplier_id !== null ? { supplierId: line.supplier_id } : {}),
    }));
}

export interface SupplierOpeningBalance {
  /** What the business owed the supplier, in the base currency. */
  readonly amountMinor: number;
  /** Must be the business's opening date once one is set. */
  readonly date: string;
}

/**
 * Add Supplier with an opening balance: creates the supplier and adds
 * Cr Accounts Payable (tagged with them) to the business's opening
 * balances, in one transaction -- if the opening balance can't be posted,
 * no supplier is created either.
 */
export async function createSupplierWithOpeningBalance(
  request: CreateSupplierRequest,
  openingBalance: SupplierOpeningBalance,
  audit: AuditContext,
): Promise<SupplierRow> {
  const { tenantId } = request;
  const tenant = await tenantsService.getTenant(tenantId);
  if (request.currency !== undefined && request.currency !== tenant.base_currency) {
    throw new DomainError(
      "CURRENCY_MISMATCH",
      `Opening balances are in ${tenant.base_currency}; enter this supplier's opening balance as a bill in ${request.currency} instead`,
    );
  }
  const payable = await accountsService.findSystemAccount(tenantId, "PAYABLE");
  if (!payable) {
    throw new DomainError("SYSTEM_ACCOUNT_MISSING", "The business has no PAYABLE account for the supplier's opening balance");
  }

  const view = await getOpeningBalances(tenantId);
  if (view.date !== null && view.date !== openingBalance.date) {
    throw new DomainError(
      "OPENING_BALANCE_DATE_MISMATCH",
      `The business's opening balances are dated ${view.date}; a supplier's opening balance must use the same date`,
    );
  }

  const supplierId = randomUUID();
  const lines: CreateJournalLineRequest[] = [
    ...(view.journal ? linesOf(view.journal, view.opening_balance_account_id) : []),
    {
      accountId: payable.id,
      debitMinor: 0,
      creditMinor: openingBalance.amountMinor,
      narrative: `Opening balance: ${request.name}`,
      supplierId,
    },
  ];

  let supplier: SupplierRow | undefined;
  await replaceOpening(tenantId, openingBalance.date, lines, audit, {
    newSupplierIds: [supplierId],
    before: async (client) => {
      supplier = await suppliersService.insertSupplier(client, { ...request, id: supplierId }, audit);
    },
  });
  return supplier!;
}
