/**
 * Onboarding service -- the public interface of this module.
 *
 * Beyond creating the tenant and its first user, onboarding also seeds
 * everything a brand-new tenant needs to start recording immediately: one
 * OPEN accounting period, and the chart of accounts from the template it
 * chose (FR-COA-02, SRS Appendix A -- see @jibuks/domain chartTemplates),
 * with VAT accounts only for a VAT-registered business.
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

import { DomainError, templateAccounts, type ChartTemplateKey } from "@jibuks/domain";
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
  /** Which chart of accounts to seed (FR-COA-02); GENERAL if omitted. */
  readonly chartTemplate?: ChartTemplateKey;
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

export async function onboard(request: OnboardRequest): Promise<OnboardServiceResult> {
  const existing = await usersService.findByExternalIdpSubject(request.externalIdpSubject);
  if (existing) {
    throw new DomainError(
      "USER_ALREADY_EXISTS",
      `This identity is already onboarded (user ${existing.id}, tenant ${existing.tenant_id})`,
    );
  }

  const chartTemplate = request.chartTemplate ?? "GENERAL";
  const { tenant, user } = await repository.onboardTenant({ ...request, chartTemplate });
  const audit: AuditContext = { actorUserId: user.id };

  const period = await periodsService.createPeriod(
    { tenantId: tenant.id, startDate: request.periodStartDate, endDate: endOfMonth(request.periodStartDate) },
    audit,
  );

  const accounts: AccountRow[] = [];
  for (const starter of templateAccounts(chartTemplate, request.vatRegistered)) {
    accounts.push(
      await accountsService.createAccount(
        {
          tenantId: tenant.id,
          code: starter.code,
          name: starter.name,
          type: starter.type,
          ...(starter.systemKey ? { systemKey: starter.systemKey } : {}),
        },
        audit,
      ),
    );
  }

  return { tenant, user, period, accounts };
}
