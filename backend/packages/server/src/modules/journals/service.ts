/**
 * Journals service -- the public interface of this module.
 *
 * This is where @jibuks/ledger's pure posting logic meets real data: real
 * accounts and periods loaded from the database, assembled into the
 * PostingContext shape validateForPosting expects.
 */

import { randomUUID } from "node:crypto";
import { DomainError, type CurrencyCode, type JournalSource, type Journal as DomainJournal } from "@jibuks/domain";
import { validateForPosting, buildReversal as domainBuildReversal, type PostingContext, type PeriodSnapshot } from "@jibuks/ledger";
import type { AuditContext } from "@jibuks/db";
import * as repository from "./repository.js";
import type { JournalWithLines, CreateJournalLineInput } from "./repository.js";
import * as accountsService from "../accounts/service.js";
import * as periodsService from "../periods/service.js";

export interface CreateJournalLineRequest {
  readonly accountId: string;
  readonly debitMinor: number;
  readonly creditMinor: number;
  readonly narrative?: string;
  readonly projectId?: string;
  readonly department?: string;
}

export interface CreateJournalRequest {
  readonly tenantId: string;
  readonly clientUuid: string;
  readonly branchId?: string;
  readonly date: string;
  readonly currency: CurrencyCode;
  readonly description: string;
  readonly reference?: string;
  readonly source: JournalSource;
  readonly lines: readonly CreateJournalLineRequest[];
}

/** Converts a bigint-as-string column from Postgres to a safe number,
 * throwing rather than silently truncating if it is ever out of range. */
function toSafeNumber(value: string, fieldName: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new DomainError("MONEY_OUT_OF_RANGE", `${fieldName} value ${value} is not representable as a safe integer`);
  }
  return n;
}

function toDomainJournal(row: JournalWithLines): DomainJournal {
  return {
    id: row.id,
    clientUuid: row.client_uuid,
    tenantId: row.tenant_id,
    ...(row.branch_id ? { branchId: row.branch_id } : {}),
    date: row.date,
    currency: row.currency as never,
    description: row.description,
    ...(row.reference ? { reference: row.reference } : {}),
    source: row.source as never,
    status: row.status,
    periodId: row.period_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    ...(row.approved_by ? { approvedBy: row.approved_by } : {}),
    ...(row.reversal_of_journal_id ? { reversalOfJournalId: row.reversal_of_journal_id } : {}),
    lines: row.lines.map((line) => ({
      accountId: line.account_id,
      debitMinor: toSafeNumber(line.debit_minor, "debit_minor"),
      creditMinor: toSafeNumber(line.credit_minor, "credit_minor"),
      ...(line.narrative ? { narrative: line.narrative } : {}),
      ...(line.project_id ? { projectId: line.project_id } : {}),
      ...(line.department ? { department: line.department } : {}),
    })),
  };
}

async function buildPostingContext(tenantId: string): Promise<PostingContext> {
  const accounts = await accountsService.loadAccountSnapshots(tenantId);
  const periods = await periodsService.listPeriods(tenantId);

  const periodSnapshots: PeriodSnapshot[] = periods.map((p) => ({
    id: p.id,
    tenantId: p.tenant_id,
    startDate: p.start_date,
    endDate: p.end_date,
    status: p.status,
  }));

  return { tenantId, accounts, periods: periodSnapshots };
}

function serializeLinesForRepository(
  lines: readonly CreateJournalLineRequest[],
): CreateJournalLineInput[] {
  return lines.map((line) => ({
    accountId: line.accountId,
    debitMinor: line.debitMinor,
    creditMinor: line.creditMinor,
    ...(line.narrative !== undefined ? { narrative: line.narrative } : {}),
    ...(line.projectId !== undefined ? { projectId: line.projectId } : {}),
    ...(line.department !== undefined ? { department: line.department } : {}),
  }));
}

export async function createJournal(request: CreateJournalRequest, audit: AuditContext): Promise<JournalWithLines> {
  const context = await buildPostingContext(request.tenantId);

  const validated = validateForPosting(
    {
      clientUuid: request.clientUuid,
      tenantId: request.tenantId,
      ...(request.branchId !== undefined ? { branchId: request.branchId } : {}),
      date: request.date,
      currency: request.currency,
      description: request.description,
      ...(request.reference !== undefined ? { reference: request.reference } : {}),
      source: request.source,
      lines: request.lines,
    },
    context,
  );

  return repository.createJournal(
    {
      tenantId: request.tenantId,
      clientUuid: request.clientUuid,
      ...(request.branchId !== undefined ? { branchId: request.branchId } : {}),
      periodId: validated.periodId,
      date: request.date,
      currency: request.currency,
      description: request.description,
      ...(request.reference !== undefined ? { reference: request.reference } : {}),
      source: request.source,
      createdBy: audit.actorUserId,
      lines: serializeLinesForRepository(request.lines),
    },
    audit,
  );
}

export async function listJournals(tenantId: string) {
  return repository.listJournals(tenantId);
}

export async function getJournal(tenantId: string, journalId: string): Promise<JournalWithLines> {
  const journal = await repository.getJournalWithLines(tenantId, journalId);
  if (!journal) {
    throw new DomainError("ACCOUNT_NOT_FOUND", `Journal ${journalId} not found`);
  }
  return journal;
}

/**
 * FR-ACC-02: the only correction mechanism. Builds a reversing journal using
 * @jibuks/ledger's buildReversal (guards: must be POSTED, must not already
 * be reversed), then posts it through the SAME createJournal path as any
 * other journal -- a reversal receives no special treatment or shortcut
 * around validateForPosting.
 */
export async function reverseJournal(
  tenantId: string,
  journalId: string,
  reason: string,
  audit: AuditContext,
): Promise<JournalWithLines> {
  const originalRow = await repository.getJournalWithLines(tenantId, journalId);
  if (!originalRow) {
    throw new DomainError("ACCOUNT_NOT_FOUND", `Journal ${journalId} not found`);
  }

  const existingReversal = await repository.findJournalByReversalTarget(tenantId, journalId);
  if (existingReversal) {
    throw new DomainError("JOURNAL_ALREADY_REVERSED", `Journal ${journalId} was already reversed by ${existingReversal.id}`);
  }

  const original = toDomainJournal(originalRow);
  const reversalInput = domainBuildReversal(original, {
    date: new Date().toISOString().slice(0, 10),
    reason,
    by: audit.actorUserId,
    clientUuid: randomUUID(),
  });

  const context = await buildPostingContext(tenantId);
  const validated = validateForPosting(reversalInput, context);

  return repository.createJournal(
    {
      tenantId,
      clientUuid: reversalInput.clientUuid,
      ...(reversalInput.branchId !== undefined ? { branchId: reversalInput.branchId } : {}),
      periodId: validated.periodId,
      date: reversalInput.date,
      currency: reversalInput.currency,
      description: reversalInput.description,
      ...(reversalInput.reference !== undefined ? { reference: reversalInput.reference } : {}),
      source: reversalInput.source,
      createdBy: audit.actorUserId,
      reversalOfJournalId: journalId,
      lines: serializeLinesForRepository(
        reversalInput.lines.map((l: (typeof reversalInput.lines)[number]) => ({
          accountId: l.accountId,
          debitMinor: l.debitMinor,
          creditMinor: l.creditMinor,
          ...(l.narrative !== undefined ? { narrative: l.narrative } : {}),
          ...(l.projectId !== undefined ? { projectId: l.projectId } : {}),
          ...(l.department !== undefined ? { department: l.department } : {}),
        })),
      ),
    },
    audit,
  );
}