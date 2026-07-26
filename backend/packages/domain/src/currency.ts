/**
 * ISO 4217 currency handling.
 *
 * SRS: C-07, DR-03, FR-ACC-06, Section 9.1 (Money).
 * Money is an integer count of minor units plus an explicit currency code.
 * The exponent tells us how many minor units make one major unit, and it is
 * NOT universally 2, UGX and RWF have no minor unit at all. Assuming 2
 * everywhere is the classic way to be wrong by a factor of 100 in Kampala.
 */

export const CURRENCIES = {
  KES: { exponent: 2, name: "Kenyan Shilling" },
  UGX: { exponent: 0, name: "Ugandan Shilling" },
  TZS: { exponent: 2, name: "Tanzanian Shilling" },
  RWF: { exponent: 0, name: "Rwandan Franc" },
  ETB: { exponent: 2, name: "Ethiopian Birr" },
  NGN: { exponent: 2, name: "Nigerian Naira" },
  ZAR: { exponent: 2, name: "South African Rand" },
  GHS: { exponent: 2, name: "Ghanaian Cedi" },
  USD: { exponent: 2, name: "US Dollar" },
  EUR: { exponent: 2, name: "Euro" },
  GBP: { exponent: 2, name: "Pound Sterling" },
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;

export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === "string" && value in CURRENCIES;
}

export function exponentOf(code: CurrencyCode): number {
  return CURRENCIES[code].exponent;
}