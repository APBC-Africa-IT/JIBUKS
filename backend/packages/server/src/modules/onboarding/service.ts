/**
 * Onboarding service -- the public interface of this module.
 *
 * Beyond creating the tenant and its first user, onboarding also seeds
 * everything a brand-new tenant needs to use the guided Credit Sale/Cash
 * Sale/Write Bill/Write Cheque endpoints immediately: one OPEN accounting
 * period, and a starter chart of accounts (mirroring QuickBooks-style
 * setup, which asks for VAT registration and a books-start date up front).
 *
 * This seeding is deliberately NOT part of the same database transaction
 * as tenant+user creation -- each module owns its own table exclusively
 * (AD-02), so periods and accounts are created through their own services,
 * each in their own transaction, the same way journals/service.ts calls
 * customers/service.ts and suppliers/service.ts. A failure here leaves a
 * valid (if incomplete) tenant that can still be repaired manually via
 * POST /periods and POST /accounts -- it does not leave a half-created
 * tenant or user.
 */

import type { AccountType } from "@jibuks/domain";
import { DomainError } from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import * as usersService from "../users/service.js";
import * as periodsService from "../periods/service.js";
import type { PeriodRow } from "../periods/repository.js";
import * as accountsService from "../accounts/service.js";
import type { AccountRow } from "../accounts/repository.js";
import * as repository from "./repository.js";
import type { OnboardResult } from "./repository.js";

export interface OnboardRequest {
  readonly tenantName: string;
  readonly tenantType: "BUSINESS" | "NGO" | "HOUSEHOLD";
  readonly baseCurrency: string;
  readonly externalIdpSubject: string;
  readonly userName: string;
  readonly email?: string;
  readonly phone?: string;
  readonly vatRegistered: boolean;
  readonly periodStartDate: string;
}

export interface OnboardServiceResult extends OnboardResult {
  readonly period: PeriodRow;
  readonly accounts: readonly AccountRow[];
}

/** Last calendar day of periodStartDate's month, as YYYY-MM-DD. Onboarding
 * seeds exactly one period covering that first month -- matching this
 * codebase's existing convention (see e.g. journals.test.ts fixtures) of
 * monthly periods, rather than inventing a fiscal-year concept nothing
 * else here models yet. */
function endOfMonth(dateStr: string): string {
  const [year, month] = dateStr.split("-").map(Number) as [number, number, number];
  // Day 0 of next month = last day of this month (UTC, so no local-timezone drift).
  const last = new Date(Date.UTC(year, month, 0));
  return last.toISOString().slice(0, 10);
}

interface StarterAccount {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  /** Only seeded when the tenant is VAT-registered. */
  readonly vatOnly?: boolean;
}

/** A minimal starter chart of accounts -- exactly what the four guided
 * endpoints (Credit Sale, Cash Sale, Write Bill, Write Cheque) need to
 * work immediately: Cash/Bank, AR, AP, Sales, Purchases, Owner's Equity,
 * and VAT Payable/Recoverable for a VAT-registered tenant. */
const STARTER_ACCOUNTS: readonly StarterAccount[] = [
  { code: "1000", name: "Cash", type: "ASSET" },
  { code: "1010", name: "Bank", type: "ASSET" },
  { code: "1100", name: "Accounts Receivable", type: "ASSET" },
  { code: "1200", name: "VAT Recoverable (Input VAT)", type: "ASSET", vatOnly: true },
  { code: "2000", name: "Accounts Payable", type: "LIABILITY" },
  { code: "2100", name: "VAT Payable (Output VAT)", type: "LIABILITY", vatOnly: true },
  { code: "3000", name: "Owner's Equity", type: "EQUITY" },
  { code: "4000", name: "Sales Revenue", type: "INCOME" },
  { code: "5000", name: "Purchases", type: "EXPENSE" },
  { code: "5100", name: "General Expenses", type: "EXPENSE" },
];

export async function onboard(request: OnboardRequest): Promise<OnboardServiceResult> {
  const existing = await usersService.findByExternalIdpSubject(request.externalIdpSubject);
  if (existing) {
    throw new DomainError(
      "USER_ALREADY_EXISTS",
      `This identity is already onboarded (user ${existing.id}, tenant ${existing.tenant_id})`,
    );
  }

  const { tenant, user } = await repository.onboardTenant(request);
  const audit: AuditContext = { actorUserId: user.id };

  const period = await periodsService.createPeriod(
    { tenantId: tenant.id, startDate: request.periodStartDate, endDate: endOfMonth(request.periodStartDate) },
    audit,
  );

  const accounts: AccountRow[] = [];
  for (const starter of STARTER_ACCOUNTS) {
    if (starter.vatOnly && !request.vatRegistered) {
      continue;
    }
    accounts.push(
      await accountsService.createAccount(
        { tenantId: tenant.id, code: starter.code, name: starter.name, type: starter.type },
        audit,
      ),
    );
  }

  return { tenant, user, period, accounts };
}
