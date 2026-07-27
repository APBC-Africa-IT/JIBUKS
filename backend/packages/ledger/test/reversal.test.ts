/**
 * Tests for reversal.ts.
 * Covers FR-ACC-02: reversal is the only correction mechanism, a draft
 * cannot be reversed, and an already-reversed journal cannot be reversed
 * again.
 */

import { describe, expect, it } from "vitest";
import { DomainError, type Journal } from "@jibuks/domain";
import { buildReversal } from "../src/index.js";

const TENANT = "550e8400-e29b-41d4-a716-446655440000";
const CASH = "660e8400-e29b-41d4-a716-446655440001";
const SALES = "770e8400-e29b-41d4-a716-446655440002";
const USER = "990e8400-e29b-41d4-a716-446655440099";

function postedJournal(overrides: Partial<Journal> = {}): Journal {
  return {
    id: "aa0e8400-e29b-41d4-a716-446655440004",
    clientUuid: "bb0e8400-e29b-41d4-a716-446655440005",
    tenantId: TENANT,
    date: "2026-07-15",
    currency: "KES",
    description: "Cash sale",
    reference: "INV-001",
    source: "CASHBOOK",
    status: "POSTED",
    periodId: "period-open",
    createdBy: USER,
    createdAt: "2026-07-15T10:00:00Z",
    lines: [
      { accountId: CASH, debitMinor: 1000, creditMinor: 0, narrative: "Till receipt" },
      { accountId: SALES, debitMinor: 0, creditMinor: 1000 },
    ],
    ...overrides,
  };
}

describe("buildReversal -- happy path", () => {
  it("swaps every line's debit and credit", () => {
    const reversal = buildReversal(postedJournal(), { date: "2026-07-16", reason: "Posted in error", by: USER });
    expect(reversal.lines[0]!.accountId).toBe(CASH);
    expect(reversal.lines[0]!.debitMinor).toBe(0);
    expect(reversal.lines[0]!.creditMinor).toBe(1000);
    expect(reversal.lines[1]!.accountId).toBe(SALES);
    expect(reversal.lines[1]!.debitMinor).toBe(1000);
    expect(reversal.lines[1]!.creditMinor).toBe(0);
  });

  it("preserves tenant, currency and branch from the original", () => {
    const original = postedJournal({ branchId: "cc0e8400-e29b-41d4-a716-446655440006" });
    const reversal = buildReversal(original, { date: "2026-07-16", reason: "Error", by: USER });
    expect(reversal.tenantId).toBe(TENANT);
    expect(reversal.currency).toBe("KES");
    expect(reversal.branchId).toBe("cc0e8400-e29b-41d4-a716-446655440006");
  });

  it("marks the source as REVERSAL", () => {
    const reversal = buildReversal(postedJournal(), { date: "2026-07-16", reason: "Error", by: USER });
    expect(reversal.source).toBe("REVERSAL");
  });

  it("references the original in the description and reference", () => {
    const reversal = buildReversal(postedJournal(), { date: "2026-07-16", reason: "Wrong amount", by: USER });
    expect(reversal.description).toContain("INV-001");
    expect(reversal.description).toContain("Wrong amount");
    expect(reversal.reference).toBe("REV-INV-001");
  });

  it("prefixes carried-over narratives with 'Reversal:'", () => {
    const reversal = buildReversal(postedJournal(), { date: "2026-07-16", reason: "Error", by: USER });
    expect(reversal.lines[0]!.narrative).toBe("Reversal: Till receipt");
  });

  it("uses a supplied clientUuid when given, otherwise generates one", () => {
    const withUuid = buildReversal(postedJournal(), {
      date: "2026-07-16",
      reason: "Error",
      by: USER,
      clientUuid: "dd0e8400-e29b-41d4-a716-446655440007",
    });
    expect(withUuid.clientUuid).toBe("dd0e8400-e29b-41d4-a716-446655440007");

    const withoutUuid = buildReversal(postedJournal(), { date: "2026-07-16", reason: "Error", by: USER });
    expect(withoutUuid.clientUuid).toBeTruthy();
    expect(withoutUuid.clientUuid).not.toBe(withUuid.clientUuid);
  });

  it("returns a plain JournalInput, not a Journal -- the reversal is not pre-posted", () => {
    const reversal = buildReversal(postedJournal(), { date: "2026-07-16", reason: "Error", by: USER });
    expect(reversal).not.toHaveProperty("id");
    expect(reversal).not.toHaveProperty("status");
  });
});

describe("buildReversal -- guard clauses (FR-ACC-02)", () => {
  it("refuses to reverse a journal that is not POSTED", () => {
    const draft = postedJournal({ status: "DRAFT" });
    expect(() => buildReversal(draft, { date: "2026-07-16", reason: "Error", by: USER })).toThrow(DomainError);
    try {
      buildReversal(draft, { date: "2026-07-16", reason: "Error", by: USER });
    } catch (e) {
      expect((e as DomainError).code).toBe("JOURNAL_IMMUTABLE");
    }
  });

  it("refuses to reverse a journal that has already been reversed", () => {
    const alreadyReversed = postedJournal({ reversedByJournalId: "ee0e8400-e29b-41d4-a716-446655440008" });
    expect(() => buildReversal(alreadyReversed, { date: "2026-07-16", reason: "Error", by: USER })).toThrow(
      DomainError,
    );
    try {
      buildReversal(alreadyReversed, { date: "2026-07-16", reason: "Error", by: USER });
    } catch (e) {
      expect((e as DomainError).code).toBe("JOURNAL_ALREADY_REVERSED");
    }
  });
});