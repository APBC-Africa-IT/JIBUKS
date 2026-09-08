/**
 * Domain error carrying a stable machine-readable code.
 *
 * SRS Section 9.1 (Errors): RFC 7807 problem details with "a stable
 * machine-readable code, a human-readable message, and field-level detail".
 * The HTTP layer maps these codes to problem+json; the domain layer never
 * imports HTTP concerns.
 */

export type DomainErrorCode =
  // money
  | "MONEY_NOT_INTEGER"
  | "MONEY_OUT_OF_RANGE"
  | "MONEY_UNPARSEABLE"
  | "MONEY_TOO_PRECISE"
  | "CURRENCY_MISMATCH"
  | "CURRENCY_UNSUPPORTED"
  // ledger -- FR-ACC-01, FR-ACC-02, FR-ACC-03
  | "JOURNAL_UNBALANCED"
  | "JOURNAL_TOO_FEW_LINES"
  | "JOURNAL_LINE_AMBIGUOUS"
  | "JOURNAL_LINE_EMPTY"
  | "JOURNAL_IMMUTABLE"
  | "JOURNAL_ALREADY_REVERSED"
  | "PERIOD_LOCKED"
  | "PERIOD_NOT_FOUND"
  | "ACCOUNT_NOT_FOUND"
  | "ACCOUNT_INACTIVE"
  | "ACCOUNT_NOT_POSTABLE"
  | "TENANT_MISMATCH"
  // customers / suppliers
  | "CUSTOMER_NOT_FOUND"
  | "SUPPLIER_NOT_FOUND"
  // users
  | "USER_NOT_FOUND"
  | "USER_ALREADY_EXISTS"
  | "USER_INACTIVE";

export interface FieldDetail {
  readonly path: string;
  readonly message: string;
}

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: readonly FieldDetail[];

  constructor(code: DomainErrorCode, message: string, details: readonly FieldDetail[] = []) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}