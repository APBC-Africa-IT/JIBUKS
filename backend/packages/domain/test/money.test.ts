/**
 * Tests for money.ts.
 * Covers C-07 (no floats), currency-mismatch guarding, and parseMajor,
 * which is the boundary where user-typed text becomes minor units.
 */

import { describe, expect, it } from "vitest";
import {
  add,
  compare,
  DomainError,
  equals,
  formatMajor,
  formatWithCurrency,
  isNegative,
  isZero,
  money,
  negate,
  parseMajor,
  subtract,
  sum,
  zero,
} from "../src/index.js";

describe("money()", () => {
  it("accepts an integer minor-unit amount with a valid currency", () => {
    const m = money(10050, "KES");
    expect(m.minor).toBe(10050);
    expect(m.currency).toBe("KES");
  });

  it("rejects a non-integer amount", () => {
    expect(() => money(100.5, "KES")).toThrow(DomainError);
    try {
      money(100.5, "KES");
    } catch (e) {
      expect((e as DomainError).code).toBe("MONEY_NOT_INTEGER");
    }
  });

  it("rejects an unsafe integer", () => {
    expect(() => money(Number.MAX_SAFE_INTEGER + 1, "KES")).toThrow(DomainError);
  });

  it("rejects an unsupported currency code", () => {
    // @ts-expect-error deliberately passing an invalid currency
    expect(() => money(100, "XYZ")).toThrow(DomainError);
  });
});

describe("arithmetic", () => {
  it("adds two amounts in the same currency", () => {
    const result = add(money(500, "KES"), money(250, "KES"));
    expect(result.minor).toBe(750);
  });

  it("subtracts two amounts in the same currency", () => {
    const result = subtract(money(500, "KES"), money(250, "KES"));
    expect(result.minor).toBe(250);
  });

  it("throws when combining different currencies", () => {
    expect(() => add(money(500, "KES"), money(250, "UGX"))).toThrow(DomainError);
    try {
      add(money(500, "KES"), money(250, "UGX"));
    } catch (e) {
      expect((e as DomainError).code).toBe("CURRENCY_MISMATCH");
    }
  });

  it("negates an amount", () => {
    expect(negate(money(500, "KES")).minor).toBe(-500);
  });

  it("sums a list of amounts", () => {
    const total = sum([money(100, "KES"), money(200, "KES"), money(300, "KES")], "KES");
    expect(total.minor).toBe(600);
  });

  it("sums an empty list to zero", () => {
    expect(sum([], "KES").minor).toBe(0);
  });
});

describe("comparisons", () => {
  it("detects zero and non-zero", () => {
    expect(isZero(zero("KES"))).toBe(true);
    expect(isZero(money(1, "KES"))).toBe(false);
  });

  it("detects negative amounts", () => {
    expect(isNegative(money(-1, "KES"))).toBe(true);
    expect(isNegative(money(0, "KES"))).toBe(false);
  });

  it("compares two amounts", () => {
    expect(compare(money(100, "KES"), money(200, "KES"))).toBe(-1);
    expect(compare(money(200, "KES"), money(100, "KES"))).toBe(1);
    expect(compare(money(100, "KES"), money(100, "KES"))).toBe(0);
  });

  it("checks equality including currency", () => {
    expect(equals(money(100, "KES"), money(100, "KES"))).toBe(true);
    expect(equals(money(100, "KES"), money(100, "UGX"))).toBe(false);
  });
});

describe("parseMajor()", () => {
  it("parses a plain amount for a 2-decimal currency", () => {
    expect(parseMajor("1250.75", "KES").minor).toBe(125075);
  });

  it("parses an amount with thousands separators", () => {
    expect(parseMajor("1,250.75", "KES").minor).toBe(125075);
  });

  it("parses a whole-number amount with no fraction", () => {
    expect(parseMajor("500", "KES").minor).toBe(50000);
  });

  it("parses a zero-exponent currency without a decimal point", () => {
    expect(parseMajor("1500", "UGX").minor).toBe(1500);
  });

  it("parses a negative amount", () => {
    expect(parseMajor("-500", "KES").minor).toBe(-50000);
  });

  it("rejects too many decimal places for the currency", () => {
    expect(() => parseMajor("500.123", "KES")).toThrow(DomainError);
  });

  it("rejects a decimal point on a zero-exponent currency", () => {
    expect(() => parseMajor("1500.50", "UGX")).toThrow(DomainError);
  });

  it("rejects unparseable input", () => {
    expect(() => parseMajor("not-a-number", "KES")).toThrow(DomainError);
    expect(() => parseMajor("", "KES")).toThrow(DomainError);
  });
});

describe("formatting", () => {
  it("formats minor units back to a major-unit string", () => {
    expect(formatMajor(money(125075, "KES"))).toBe("1250.75");
  });

  it("formats a zero-exponent currency with no decimal point", () => {
    expect(formatMajor(money(1500, "UGX"))).toBe("1500");
  });

  it("formats a negative amount with a leading minus", () => {
    expect(formatMajor(money(-50000, "KES"))).toBe("-500.00");
  });

  it("pads small amounts correctly", () => {
    expect(formatMajor(money(5, "KES"))).toBe("0.05");
  });

  it("includes the currency code", () => {
    expect(formatWithCurrency(money(125075, "KES"))).toBe("KES 1250.75");
  });

  it("round-trips parseMajor and formatMajor", () => {
    const original = "1250.75";
    const parsed = parseMajor(original, "KES");
    expect(formatMajor(parsed)).toBe(original);
  });
});