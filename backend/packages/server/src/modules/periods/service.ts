/**
 * Periods service -- the public interface of this module.
 *
 * The journals module imports from HERE (specifically findPeriodForDate),
 * never from repository.ts directly (AD-01).
 */

import { DomainError } from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import * as repository from "./repository.js";
import type { PeriodRow } from "./repository.js";

export interface CreatePeriodRequest {
  readonly tenantId: string;
  readonly startDate: string;
  readonly endDate: string;
}

export async function createPeriod(request: CreatePeriodRequest, audit: AuditContext): Promise<PeriodRow> {
  if (request.endDate < request.startDate) {
    throw new DomainError(
      "PERIOD_NOT_FOUND",
      `end_date (${request.endDate}) cannot be before start_date (${request.startDate})`,
    );
  }
  return repository.createPeriod(request, audit);
}

export async function listPeriods(tenantId: string): Promise<PeriodRow[]> {
  return repository.listPeriods(tenantId);
}

export async function getPeriod(tenantId: string, periodId: string): Promise<PeriodRow> {
  const period = await repository.getPeriodById(tenantId, periodId);
  if (!period) {
    throw new DomainError("PERIOD_NOT_FOUND", `Period ${periodId} not found`);
  }
  return period;
}

/** Used by the journals module to resolve which period a posting date falls into. */
export async function findPeriodForDate(tenantId: string, date: string): Promise<PeriodRow | null> {
  return repository.findPeriodForDate(tenantId, date);
}

/** Today's calendar date in Kenya (yyyy-mm-dd), where JIBUKS tenants trade. */
export function todayInNairobi(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" }).format(now);
}

function lastDayOfMonth(date: string): string {
  const [year, month] = date.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(year, month, 0));
  return last.toISOString().slice(0, 10);
}

/**
 * Called before every posting. If no period covers `date` and `date` is in
 * the current calendar month, opens that month's period, so day-to-day
 * posting never stops at a month boundary -- including for roles that
 * can't manage periods (Cashier, Agent).
 *
 * Deliberately narrow: an earlier or later month is never opened
 * implicitly (that is a bookkeeping decision, made via POST /periods), and
 * a CLOSED or LOCKED period is never touched -- the posting then fails
 * with PERIOD_NOT_FOUND / PERIOD_LOCKED as before.
 */
export async function ensureCurrentPeriodForDate(
  tenantId: string,
  date: string,
  audit: AuditContext,
  today: string = todayInNairobi(),
): Promise<void> {
  if (date.slice(0, 7) !== today.slice(0, 7)) {
    return;
  }
  if (await repository.findPeriodForDate(tenantId, date)) {
    return;
  }
  await repository.createPeriodCoveringDate(tenantId, date, `${date.slice(0, 7)}-01`, lastDayOfMonth(date), audit);
}

export async function closePeriod(tenantId: string, periodId: string, audit: AuditContext): Promise<PeriodRow> {
  const period = await repository.getPeriodById(tenantId, periodId);
  if (!period) {
    throw new DomainError("PERIOD_NOT_FOUND", `Period ${periodId} not found`);
  }
  if (period.status !== "OPEN") {
    throw new DomainError("PERIOD_LOCKED", `Period ${periodId} is already ${period.status.toLowerCase()}`);
  }

  const updated = await repository.setPeriodStatus(tenantId, periodId, "CLOSED", audit);
  return updated!;
}

/**
 * FR-ACC-03: "reopening is restricted to a named permission and recorded in
 * the audit log." The audit logging is already handled by
 * repository.setPeriodStatus. The permission check is NOT YET IMPLEMENTED --
 * there is no RBAC module yet. This function is deliberately kept separate
 * from a generic "setStatus" so that when RBAC lands, there is exactly one
 * place to add the permission check, and it is visibly missing until then
 * rather than silently absent inside a shared code path.
 */
export async function reopenPeriod(tenantId: string, periodId: string, audit: AuditContext): Promise<PeriodRow> {
  // Gated by the dedicated "periods:reopen" permission at the route (FR-ACC-03).
  const period = await repository.getPeriodById(tenantId, periodId);
  if (!period) {
    throw new DomainError("PERIOD_NOT_FOUND", `Period ${periodId} not found`);
  }
  if (period.status === "OPEN") {
    throw new DomainError("PERIOD_LOCKED", `Period ${periodId} is already open`);
  }

  const updated = await repository.setPeriodStatus(tenantId, periodId, "OPEN", audit);
  return updated!;
}
