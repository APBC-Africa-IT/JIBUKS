/**
 * Central error handler.
 *
 * SRS Section 9.1 (Errors): "RFC 7807 problem detail objects with a stable
 * machine-readable code, a human-readable message, and field-level detail
 * where applicable."
 *
 * This is the ONLY place that maps a DomainErrorCode to an HTTP status.
 * Controllers never set status codes for domain failures themselves --
 * they just throw DomainError, or let one propagate from @jibuks/ledger,
 * and this middleware translates it consistently, everywhere, once.
 */

import type { NextFunction, Request, Response } from "express";
import { DomainError, type DomainErrorCode } from "@jibuks/domain";

const STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  // money -- malformed input from the client
  MONEY_NOT_INTEGER: 400,
  MONEY_OUT_OF_RANGE: 400,
  MONEY_UNPARSEABLE: 400,
  MONEY_TOO_PRECISE: 400,
  CURRENCY_MISMATCH: 400,
  CURRENCY_UNSUPPORTED: 400,
  // ledger -- mostly the request conflicts with business rules (422),
  // except lookups that failed to find something (404) and the tenant
  // check, which is a authorization-shaped failure (403).
  JOURNAL_UNBALANCED: 422,
  JOURNAL_TOO_FEW_LINES: 422,
  JOURNAL_LINE_AMBIGUOUS: 422,
  JOURNAL_LINE_EMPTY: 422,
  JOURNAL_IMMUTABLE: 422,
  JOURNAL_ALREADY_REVERSED: 422,
  PERIOD_LOCKED: 422,
  PERIOD_NOT_FOUND: 404,
  ACCOUNT_NOT_FOUND: 404,
  ACCOUNT_INACTIVE: 422,
  ACCOUNT_NOT_POSTABLE: 422,
  TENANT_MISMATCH: 403,
};

/** RFC 7807-shaped body. `type` is a stable URI-like identifier for the
 * error code; we use a simple tag: scheme rather than standing up real
 * documentation URIs this early. */
function problemDetails(status: number, code: string, message: string, details?: readonly unknown[]) {
  return {
    type: `tag:jibuks,2026:error/${code}`,
    title: code,
    status,
    detail: message,
    ...(details && details.length > 0 ? { errors: details } : {}),
  };
}

/**
 * Express's error-handling middleware signature REQUIRES all four
 * parameters, even though `next` is unused -- Express detects an error
 * handler by argument count (arity), not by name.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof DomainError) {
    const status = STATUS_BY_CODE[err.code] ?? 400;
    res
      .status(status)
      .type("application/problem+json")
      .json(problemDetails(status, err.code, err.message, err.details));
    return;
  }

  // Anything that reaches here is NOT a DomainError -- i.e. not an
  // anticipated business-rule failure, but a genuine bug, a database
  // connectivity issue, etc. Never leak internals to the client.
  console.error("Unhandled error:", err);
  res
    .status(500)
    .type("application/problem+json")
    .json(problemDetails(500, "INTERNAL_ERROR", "An unexpected error occurred"));
}