/**
 * Money as integer minor units + explicit currency.
 *
 * SRS: C-07 ("Floating-point types are prohibited for monetary values"),
 * DR-03, FR-ACC-06, Section 9.1.
 *
 * Representation note. Amounts are held as `number` constrained to safe
 * integers, not `bigint`. Rationale: money crosses the API as JSON, which has
 * no bigint, and the ceiling is Number.MAX_SAFE_INTEGER minor units --
 * ~90 trillion KES in a single amount. That is far beyond any tenant balance
 * this platform will hold. Every constructor asserts integrality, so a float
 * can never enter the system unnoticed. Postgres columns remain BIGINT.
 */

import { CurrencyCode, exponentOf, isCurrencyCode } from "./currency.js";
import { DomainError } from "./errors.js";

export interface Money {
  readonly minor: number;
  readonly currency: CurrencyCode;
}

export function money(minor: number, currency: CurrencyCode): Money {
  if (!Number.isInteger(minor)) {
    throw new DomainError(
      "MONEY_NOT_INTEGER",
      `Monetary amount must be an integer count of minor units, received ${minor}`,
    );
  }
  if (!Number.isSafeInteger(minor)) {
    throw new DomainError("MONEY_OUT_OF_RANGE", `Monetary amount ${minor} exceeds the safe integer range`);
  }
  if (!isCurrencyCode(currency)) {
    throw new DomainError("CURRENCY_UNSUPPORTED", `Unsupported currency code: ${String(currency)}`);
  }
  return { minor, currency };
}

export function zero(currency: CurrencyCode): Money {
  return { minor: 0, currency };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new DomainError(
      "CURRENCY_MISMATCH",
      `Cannot combine ${a.currency} with ${b.currency}. Convert explicitly through an exchange rate.`,
    );
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor + b.minor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor - b.minor, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.minor, a.currency);
}

export function sum(amounts: readonly Money[], currency: CurrencyCode): Money {
  return amounts.reduce<Money>((acc, m) => add(acc, m), zero(currency));
}

export function isZero(a: Money): boolean {
  return a.minor === 0;
}

export function isNegative(a: Money): boolean {
  return a.minor < 0;
}

export function compare(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.minor === b.minor ? 0 : a.minor < b.minor ? -1 : 1;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minor === b.minor;
}

/**
 * Parse a human-entered major-unit string ("1,250.75") into minor units.
 * Deliberately string-based: routing user input through parseFloat is exactly
 * the rounding defect C-07 exists to prevent.
 */
export function parseMajor(input: string, currency: CurrencyCode): Money {
  const exponent = exponentOf(currency);
  const cleaned = input.trim().replace(/[\s,_]/g, "");
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!match) {
    throw new DomainError("MONEY_UNPARSEABLE", `Cannot read "${input}" as an amount`);
  }
  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > exponent) {
    throw new DomainError(
      "MONEY_TOO_PRECISE",
      `${currency} carries ${exponent} decimal place(s); "${input}" has ${fraction.length}`,
    );
  }
  const padded = fraction.padEnd(exponent, "0");
  const minor = Number(`${whole}${padded}`);
  return money(sign === "-" ? -minor : minor, currency);
}

/** Render minor units as a major-unit string, without locale grouping. */
export function formatMajor(m: Money): string {
  const exponent = exponentOf(m.currency);
  const negative = m.minor < 0;
  const digits = Math.abs(m.minor).toString().padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? "" : `.${digits.slice(digits.length - exponent)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

export function formatWithCurrency(m: Money): string {
  return `${m.currency} ${formatMajor(m)}`;
}