/**
 * Journal model.
 *
 * SRS: FR-ACC-01 (double entry enforced), FR-ACC-02 (posted journals
 * immutable; correction only by reversal), FR-ACC-05 (tenant_id mandatory,
 * branch_id / project_id optional), C-04 (append-only ledger),
 * Section 6.1 (journals / journal_lines entities).
 *
 * DRAFT is the only mutable status. Once POSTED, the row is closed to
 * amendment for every role including Super Admin (FR-AUD-02, TC-ACC-02).
 */

import type { CurrencyCode } from "./currency.js";
import type { AccountId, BranchId, CustomerId, JournalId, SupplierId, TenantId, UserId, Uuid } from "./ids.js";

export const JOURNAL_SOURCES = ["MANUAL", "CASHBOOK", "PAYMENT", "SALE", "IMPORT", "COMMUNITY", "OPENING", "REVERSAL"] as const;
export type JournalSource = (typeof JOURNAL_SOURCES)[number];

export const JOURNAL_STATUSES = ["DRAFT", "PENDING_APPROVAL", "POSTED", "REVERSED"] as const;
export type JournalStatus = (typeof JOURNAL_STATUSES)[number];

export interface JournalLineInput {
  readonly accountId: AccountId;
  /** Integer minor units. Exactly one of debitMinor / creditMinor is non-zero. */
  readonly debitMinor: number;
  readonly creditMinor: number;
  readonly narrative?: string;
  readonly projectId?: Uuid;
  readonly department?: string;
  /** Optional attribution to a customer/supplier subledger (mutually
   * exclusive) -- see packages/server/src/modules/{customers,suppliers}. */
  readonly customerId?: CustomerId;
  readonly supplierId?: SupplierId;
}

export interface JournalInput {
  /** Client-generated identity, accepted verbatim by the server (DR-05). */
  readonly clientUuid: Uuid;
  readonly tenantId: TenantId;
  /** Nullable from Phase 1 so Phase 4 needs no destructive migration (DR-02). */
  readonly branchId?: BranchId;
  /** Accounting date, calendar only, no time component (Section 9.1). */
  readonly date: string;
  readonly currency: CurrencyCode;
  readonly description: string;
  readonly reference?: string;
  readonly source: JournalSource;
  readonly lines: readonly JournalLineInput[];
}

export interface Journal extends JournalInput {
  readonly id: JournalId;
  readonly status: JournalStatus;
  readonly periodId: string;
  readonly createdBy: UserId;
  readonly createdAt: string;
  readonly approvedBy?: UserId;
  /** Set on the reversing journal, pointing at what it reverses (FR-ACC-02). */
  readonly reversalOfJournalId?: JournalId;
  /** Set on the original once a reversal has been posted against it. */
  readonly reversedByJournalId?: JournalId;
}