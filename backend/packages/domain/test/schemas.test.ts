/**
 * Tests for schemas.ts.
 * These are the Zod schemas that guard every request boundary (Section 9.1,
 * constraint C-01). If validation here is wrong, bad data reaches the
 * posting engine or the database instead of being rejected up front.
 */

import { describe, expect, it } from "vitest";
import {
  accountingDateSchema,
  createAccountSchema,
  journalInputSchema,
  journalLineSchema,
  minorUnitsSchema,
  paginationSchema,
  uuidSchema,
} from "../src/index.js";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_UUID = "660e8400-e29b-41d4-a716-446655440000";

describe("uuidSchema", () => {
  it("accepts a well-formed UUID", () => {
    expect(uuidSchema.parse(VALID_UUID)).toBe(VALID_UUID);
  });

  it("rejects a non-UUID string", () => {
    expect(() => uuidSchema.parse("not-a-uuid")).toThrow();
  });
});

describe("accountingDateSchema", () => {
  it("accepts a calendar date with no time component", () => {
    expect(accountingDateSchema.parse("2026-07-27")).toBe("2026-07-27");
  });

  it("rejects a date carrying a time component", () => {
    expect(() => accountingDateSchema.parse("2026-07-27T10:00:00Z")).toThrow();
  });

  it("rejects an impossible calendar date", () => {
    expect(() => accountingDateSchema.parse("2026-13-40")).toThrow();
  });

  it("rejects a non-date string", () => {
    expect(() => accountingDateSchema.parse("yesterday")).toThrow();
  });
});

describe("minorUnitsSchema", () => {
  it("accepts a non-negative integer", () => {
    expect(minorUnitsSchema.parse(50000)).toBe(50000);
  });

  it("accepts zero", () => {
    expect(minorUnitsSchema.parse(0)).toBe(0);
  });

  it("rejects a negative amount", () => {
    expect(() => minorUnitsSchema.parse(-1)).toThrow();
  });

  it("rejects a non-integer amount (C-07)", () => {
    expect(() => minorUnitsSchema.parse(100.5)).toThrow();
  });
});

describe("journalLineSchema", () => {
  it("accepts a valid debit-only line", () => {
    const result = journalLineSchema.parse({ accountId: VALID_UUID, debitMinor: 1000, creditMinor: 0 });
    expect(result.debitMinor).toBe(1000);
    expect(result.creditMinor).toBe(0);
  });

  it("accepts a valid credit-only line", () => {
    const result = journalLineSchema.parse({ accountId: VALID_UUID, debitMinor: 0, creditMinor: 1000 });
    expect(result.creditMinor).toBe(1000);
  });

  it("defaults debit and credit to 0 when omitted", () => {
    expect(() => journalLineSchema.parse({ accountId: VALID_UUID })).toThrow();
  });

  it("rejects a line with both a debit and a credit", () => {
    expect(() =>
      journalLineSchema.parse({ accountId: VALID_UUID, debitMinor: 1000, creditMinor: 500 }),
    ).toThrow();
  });

  it("rejects a line with neither a debit nor a credit", () => {
    expect(() => journalLineSchema.parse({ accountId: VALID_UUID, debitMinor: 0, creditMinor: 0 })).toThrow();
  });
});

describe("journalInputSchema", () => {
  const basePayload = {
    clientUuid: VALID_UUID,
    date: "2026-07-27",
    currency: "KES",
    description: "Cash sale",
    source: "CASHBOOK",
    lines: [
      { accountId: VALID_UUID, debitMinor: 1000, creditMinor: 0 },
      { accountId: OTHER_UUID, debitMinor: 0, creditMinor: 1000 },
    ],
  };

  it("accepts a well-formed two-line journal", () => {
    const result = journalInputSchema.parse(basePayload);
    expect(result.lines).toHaveLength(2);
    expect(result.currency).toBe("KES");
  });

  it("rejects a journal with fewer than two lines", () => {
    expect(() =>
      journalInputSchema.parse({ ...basePayload, lines: [basePayload.lines[0]] }),
    ).toThrow();
  });

  it("rejects an unsupported currency", () => {
    expect(() => journalInputSchema.parse({ ...basePayload, currency: "ZZZ" })).toThrow();
  });

  it("rejects a missing description", () => {
    const { description, ...rest } = basePayload;
    expect(() => journalInputSchema.parse(rest)).toThrow();
  });

  it("defaults source to MANUAL when omitted", () => {
    const { source, ...rest } = basePayload;
    const result = journalInputSchema.parse(rest);
    expect(result.source).toBe("MANUAL");
  });

  it("rejects an invalid source value", () => {
    expect(() => journalInputSchema.parse({ ...basePayload, source: "NOT_A_SOURCE" })).toThrow();
  });
});

describe("createAccountSchema", () => {
  it("accepts a minimal valid account", () => {
    const result = createAccountSchema.parse({ code: "1000", name: "Cash", type: "ASSET" });
    expect(result.tags).toEqual([]);
  });

  it("rejects an invalid account type", () => {
    expect(() => createAccountSchema.parse({ code: "1000", name: "Cash", type: "NOT_A_TYPE" })).toThrow();
  });

  it("accepts tags up to the limit", () => {
    const tags = Array.from({ length: 20 }, (_, i) => `tag-${i}`);
    const result = createAccountSchema.parse({ code: "1000", name: "Cash", type: "ASSET", tags });
    expect(result.tags).toHaveLength(20);
  });

  it("rejects more than 20 tags", () => {
    const tags = Array.from({ length: 21 }, (_, i) => `tag-${i}`);
    expect(() => createAccountSchema.parse({ code: "1000", name: "Cash", type: "ASSET", tags })).toThrow();
  });
});

describe("paginationSchema", () => {
  it("defaults limit to 50 when omitted", () => {
    const result = paginationSchema.parse({});
    expect(result.limit).toBe(50);
  });

  it("accepts an explicit cursor", () => {
    const result = paginationSchema.parse({ cursor: "abc123", limit: 10 });
    expect(result.cursor).toBe("abc123");
    expect(result.limit).toBe(10);
  });

  it("rejects a limit above the maximum", () => {
    expect(() => paginationSchema.parse({ limit: 500 })).toThrow();
  });

  it("rejects a limit below the minimum", () => {
    expect(() => paginationSchema.parse({ limit: 0 })).toThrow();
  });

  it("coerces a string limit from query parameters", () => {
    const result = paginationSchema.parse({ limit: "25" });
    expect(result.limit).toBe(25);
  });
});