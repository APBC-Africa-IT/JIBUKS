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
import type { JournalRow, JournalWithLines } from "../journals/repository.js";
import * as periodsService from "../periods/service.js";
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
  const { tenantId } = request;
  const tenant = await tenantsService.getTenant(tenantId);
  const obe = await accountsService.getOrCreateOpeningBalanceAccount(tenantId, audit);
  if (request.lines.some((line) => line.accountId === obe.id)) {
    throw new DomainError(
      "JOURNAL_LINE_AMBIGUOUS",
      "Leave Opening Balance Equity out -- the server balances the opening journal against it",
    );
  }

  const difference = request.lines.reduce((sum, line) => sum + line.debitMinor - line.creditMinor, 0);
  const lines: CreateJournalLineRequest[] = [
    ...request.lines,
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
      date: request.date,
      currency: tenant.base_currency as CurrencyCode,
      description: "Opening balances",
      source: "OPENING",
      lines,
    },
    audit,
  );

  await withTenant(tenantId, async (client) => {
    const active = await journalsService.lockActiveJournalBySource(client, tenantId, "OPENING");
    if ((active?.id ?? null) !== (current?.id ?? null)) {
      throw new DomainError("OPENING_BALANCES_LOCKED", "The opening balances changed meanwhile; reload and try again");
    }
    if (reversal) {
      await journalsService.postPreparedJournal(client, reversal, audit);
    }
    await journalsService.postPreparedJournal(client, opening, audit);
  });
  return getOpeningBalances(tenantId);
}
