/**
 * Tests for posting.ts -- the core double-entry enforcement.
 * Covers FR-ACC-01 (balance), FR-ACC-03 (period locking), FR-TEN-02
 * (tenant isolation), and the per-line account validity checks.
 */

import { describe, expect, it } from "vitest";
import { DomainError, type JournalInput } from "@jibuks/domain";
import { validateForPosting, type AccountSnapshot, type PeriodSnapshot, type PostingContext } from "../src/index.js";

const TENANT = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_TENANT = "990e8400-e29b-41d4-a716-446655440099";
const CASH = "660e8400-e29b-41d4-a716-446655440001";
const SALES = "770e8400-e29b-41d4-a716-446655440002";
const PARENT_GROUP = "880e8400-e29b-41d4-a716-446655440003";
const INACTIVE = "aa0e8400-e29b-41d4-a716-446655440004";
const FOREIGN_CURRENCY_ACCOUNT = "bb0e8400-e29b-41d4-a716-446655440005";

function makeAccounts(): Map<string, AccountSnapshot> {
  return new Map([
    [CASH, { id: CASH, tenantId: TENANT, code: "1000", type: "ASSET", isActive: true, isPostable: true, currency: null }],
    [SALES, { id: SALES, tenantId: TENANT, code: "4000", type: "INCOME", isActive: true, isPostable: true, currency: null }],
    [PARENT_GROUP, { id: PARENT_GROUP, tenantId: TENANT, code: "1", type: "ASSET", isActive: true, isPostable: false, currency: null }],
    [INACTIVE, { id: INACTIVE, tenantId: TENANT, code: "1099", type: "ASSET", isActive: false, isPostable: true, currency: null }],
    [FOREIGN_CURRENCY_ACCOUNT, { id: FOREIGN_CURRENCY_ACCOUNT, tenantId: TENANT, code: "1010", type: "ASSET", isActive: true, isPostable: true, currency: "USD" }],
  ]);
}

function makePeriods(): PeriodSnapshot[] {
  return [
    { id: "period-open", tenantId: TENANT, startDate: "2026-07-01", endDate: "2026-07-31", status: "OPEN" },
    { id: "period-closed", tenantId: TENANT, startDate: "2026-06-01", endDate: "2026-06-30", status: "CLOSED" },
    { id: "period-locked", tenantId: TENANT, startDate: "2026-05-01", endDate: "2026-05-31", status: "LOCKED" },
  ];
}

function makeContext(): PostingContext {
  return { tenantId: TENANT, accounts: makeAccounts(), periods: makePeriods() };
}

function baseJournal(overrides: Partial<JournalInput> = {}): JournalInput {
  return {
    clientUuid: "cc0e8400-e29b-41d4-a716-446655440006",
    tenantId: TENANT,
    date: "2026-07-15",
    currency: "KES",
    description: "Cash sale",
    source: "CASHBOOK",
    lines: [
      { accountId: CASH, debitMinor: 1000, creditMinor: 0 },
      { accountId: SALES, debitMinor: 0, creditMinor: 1000 },
    ],
    ...overrides,
  };
}

describe("validateForPosting -- happy path", () => {
  it("accepts a balanced two-line journal in an open period", () => {
    const result = validateForPosting(baseJournal(), makeContext());
    expect(result.periodId).toBe("period-open");
    expect(result.totalDebitMinor).toBe(1000);
    expect(result.totalCreditMinor).toBe(1000);
  });

  it("accepts a balanced multi-line journal", () => {
    const journal = baseJournal({
      lines: [
        { accountId: CASH, debitMinor: 700, creditMinor: 0 },
        { accountId: CASH, debitMinor: 300, creditMinor: 0 },
        { accountId: SALES, debitMinor: 0, creditMinor: 1000 },
      ],
    });
    const result = validateForPosting(journal, makeContext());
    expect(result.totalDebitMinor).toBe(1000);
    expect(result.totalCreditMinor).toBe(1000);
  });
});

describe("validateForPosting -- tenant isolation (FR-TEN-02)", () => {
  it("rejects a journal whose tenant does not match the posting context", () => {
    const journal = baseJournal({ tenantId: OTHER_TENANT });
    expect(() => validateForPosting(journal, makeContext())).toThrow(DomainError);
    try {
      validateForPosting(journal, makeContext());
    } catch (e) {
      expect((e as DomainError).code).toBe("TENANT_MISMATCH");
    }
  });
});

describe("validateForPosting -- structural checks", () => {
  it("rejects a journal with fewer than two lines", () => {
    const journal = baseJournal({ lines: [{ accountId: CASH, debitMinor: 1000, creditMinor: 0 }] });
    expect(() => validateForPosting(journal, makeContext())).toThrow(DomainError);
    try {
      validateForPosting(journal, makeContext());
    } catch (e) {
      expect((e as DomainError).code).toBe("JOURNAL_TOO_FEW_LINES");
    }
  });
});

describe("validateForPosting -- FR-ACC-01 balance enforcement", () => {
  it("rejects an unbalanced journal and identifies the imbalance", () => {
    const journal = baseJournal({
      lines: [
        { accountId: CASH, debitMinor: 1500, creditMinor: 0 },
        { accountId: SALES, debitMinor: 0, creditMinor: 1000 },
      ],
    });
    expect(() => validateForPosting(journal, makeContext())).toThrow(DomainError);
    try {
      validateForPosting(journal, makeContext());
    } catch (e) {
      const err = e as DomainError;
      expect(err.code).toBe("JOURNAL_UNBALANCED");
      expect(err.message).toContain("debits 1500");
      expect(err.message).toContain("credits 1000");
      expect(err.message).toContain("500");
    }
  });
});

describe("validateForPosting -- per-line account checks", () => {
  it("rejects a line referencing an unknown account", () => {
    const journal = baseJournal({
      lines: [
        { accountId: "ffffffff-ffff-4fff-8fff-ffffffffffff", debitMinor: 1000, creditMinor: 0 },
        { accountId: SALES, debitMinor: 0, creditMinor: 1000 },
      ],
    });
    expect(() => validateForPosting(journal, makeContext())).toThrow(DomainError);
    try {
      validateForPosting(journal, makeContext());
    } catch (e) {
      expect((e as DomainError).code).toBe("ACCOUNT_NOT_FOUND");
    }
  });

  it("rejects a line posting to a deactivated account", () => {
    const journal = baseJournal({
      lines: [
        { accountId: INACTIVE, debitMinor: 1000, creditMinor: 0 },
        { accountId: SALES, debitMinor: 0, creditMinor: 1000 },
      ],
    });
    try {
      validateForPosting(journal, makeContext());
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as DomainError).code).toBe("ACCOUNT_INACTIVE");
    }
  });

  it("rejects a line posting to a non-postable grouping account", () => {
    const journal = baseJournal({
      lines: [
        { accountId: PARENT_GROUP, debitMinor: 1000, creditMinor: 0 },
        { accountId: SALES, debitMinor: 0, creditMinor: 1000 },
      ],
    });
    try {
      validateForPosting(journal, makeContext());
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as DomainError).code).toBe("ACCOUNT_NOT_POSTABLE");
    }
  });

  it("rejects a line whose account currency does not match the journal currency", () => {
    const journal = baseJournal({
      currency: "KES",
      lines: [
        { accountId: FOREIGN_CURRENCY_ACCOUNT, debitMinor: 1000, creditMinor: 0 },
        { accountId: SALES, debitMinor: 0, creditMinor: 1000 },
      ],
    });
    expect(() => validateForPosting(journal, makeContext())).toThrow(DomainError);
  });

  it("reports every invalid line, not just the first", () => {
    const journal = baseJournal({
      lines: [
        { accountId: INACTIVE, debitMinor: 1000, creditMinor: 0 },
        { accountId: PARENT_GROUP, debitMinor: 0, creditMinor: 1000 },
      ],
    });
    try {
      validateForPosting(journal, makeContext());
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as DomainError;
      expect(err.details.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("validateForPosting -- FR-ACC-03 period locking", () => {
  it("rejects posting into a date with no matching period", () => {
    const journal = baseJournal({ date: "2027-01-01" });
    try {
      validateForPosting(journal, makeContext());
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as DomainError).code).toBe("PERIOD_NOT_FOUND");
    }
  });

  it("rejects posting into a closed period", () => {
    const journal = baseJournal({ date: "2026-06-15" });
    try {
      validateForPosting(journal, makeContext());
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as DomainError).code).toBe("PERIOD_LOCKED");
    }
  });

  it("rejects posting into a locked period", () => {
    const journal = baseJournal({ date: "2026-05-15" });
    try {
      validateForPosting(journal, makeContext());
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as DomainError).code).toBe("PERIOD_LOCKED");
    }
  });
});