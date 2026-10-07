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
  | "PARTY_CURRENCY_LOCKED"
  // users
  | "USER_NOT_FOUND"
  | "USER_ALREADY_EXISTS"
  | "USER_INACTIVE"
  // access control -- FR-RBAC-01..03
  | "FORBIDDEN"
  | "ROLE_NOT_FOUND"
  | "ROLE_IMMUTABLE"
  | "LAST_OWNER"
  // payments -- FR-PAY-01..07
  | "PAYMENT_NOT_FOUND"
  | "PAYMENTS_NOT_CONFIGURED"
  | "PAYMENT_PROVIDER_ERROR"
  | "PAYMENT_NOT_REPOSTABLE"
  // invoices -- FR-AR-02/05, FR-TAX-01
  | "INVOICE_NOT_FOUND"
  | "INVOICE_INVALID_STATE"
  | "INVOICE_HAS_PAYMENTS"
  | "INVOICE_OVERPAYMENT"
  | "CREDIT_NOTE_EXCEEDS_BALANCE"
  | "CREDIT_LIMIT_EXCEEDED"
  | "TAX_NOT_REGISTERED"
  // idempotency -- Section 9.1, C-08
  | "IDEMPOTENCY_KEY_INVALID"
  | "IDEMPOTENCY_KEY_REUSED"
  | "IDEMPOTENCY_REQUEST_IN_PROGRESS";

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