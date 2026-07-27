/**
 * Reversal.
 *
 * SRS FR-ACC-02: "Correction is achieved only by a reversing journal that
 * references the original. The system MUST NOT provide any means of editing
 * or deleting a posted journal." C-04 says the same at constraint level.
 *
 * There is deliberately no `updateJournal` or `deleteJournal` anywhere in this
 * package. Reversal is the only correction primitive that exists.
 */

import { DomainError, newUuid, type Journal, type JournalInput, type JournalLineInput, type UserId } from "@jibuks/domain";

export interface ReverseOptions {
  readonly date: string;
  readonly reason: string;
  readonly by: UserId;
  /** Supplied by the caller so an offline device keeps identity control (DR-05). */
  readonly clientUuid?: string;
}

/**
 * Build the reversing journal for a posted journal. Debits become credits and
 * credits become debits; the reversal references the original, and is itself
 * an ordinary journal subject to the same validation before posting.
 */
export function buildReversal(original: Journal, options: ReverseOptions): JournalInput {
  if (original.status !== "POSTED") {
    throw new DomainError(
      "JOURNAL_IMMUTABLE",
      `Only a posted journal can be reversed; this journal is ${original.status.toLowerCase()}`,
    );
  }
  if (original.reversedByJournalId) {
    throw new DomainError(
      "JOURNAL_ALREADY_REVERSED",
      `Journal ${original.id} was already reversed by ${original.reversedByJournalId}`,
    );
  }

  const lines: JournalLineInput[] = original.lines.map((line) => {
    const swapped: JournalLineInput = {
      accountId: line.accountId,
      debitMinor: line.creditMinor,
      creditMinor: line.debitMinor,
      ...(line.narrative !== undefined ? { narrative: `Reversal: ${line.narrative}` } : {}),
      ...(line.projectId !== undefined ? { projectId: line.projectId } : {}),
      ...(line.department !== undefined ? { department: line.department } : {}),
    };
    return swapped;
  });

  return {
    clientUuid: options.clientUuid ?? newUuid(),
    tenantId: original.tenantId,
    ...(original.branchId !== undefined ? { branchId: original.branchId } : {}),
    date: options.date,
    currency: original.currency,
    description: `Reversal of ${original.reference ?? original.id}: ${options.reason}`,
    ...(original.reference !== undefined ? { reference: `REV-${original.reference}` } : {}),
    source: "REVERSAL",
    lines,
  };
}