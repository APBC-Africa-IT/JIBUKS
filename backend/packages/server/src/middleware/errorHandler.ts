/**
 * Central error handler.
 *
 * SRS Section 9.1 (Errors): "RFC 7807 problem detail objects with a stable
 * machine-readable code, a human-readable message, and field-level detail
 * where applicable."
 *
 * This is the ONLY place that maps a failure -- DomainError, a Zod
 * validation failure, or a known Postgres error code -- to an HTTP status.
 * Controllers never set status codes for these failures themselves.
 */

import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { UnauthorizedError, InsufficientScopeError } from "express-oauth2-jwt-bearer";
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

/** Recognisable shape of a node-postgres error, without depending on `pg`
 * as a type import here -- this file should stay database-library-agnostic. */
interface PgError {
  code?: string;
  constraint?: string;
  table?: string;
}

function isPgError(err: unknown): err is PgError {
  return typeof err === "object" && err !== null && "code" in err;
}

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

  if (err instanceof ZodError) {
    const details = err.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    res
      .status(400)
      .type("application/problem+json")
      .json(problemDetails(400, "VALIDATION_ERROR", "The request body failed validation", details));
    return;
  }

  if (err instanceof UnauthorizedError || err instanceof InsufficientScopeError) {
    const status = err.status ?? 401;
    res
      .status(status)
      .type("application/problem+json")
      .json(problemDetails(status, "UNAUTHORIZED", err.message || "Authentication required"));
    return;
  }

  if (isPgError(err) && err.code === "23505") {
    res
      .status(409)
      .type("application/problem+json")
      .json(
        problemDetails(
          409,
          "DUPLICATE_VALUE",
          `A record with this value already exists${err.table ? ` in ${err.table}` : ""}`,
        ),
      );
    return;
  }

  // Anything reaching here is a genuine bug, connectivity issue, etc --
  // never leak internals to the client.
  console.error("Unhandled error:", err);
  res
    .status(500)
    .type("application/problem+json")
    .json(problemDetails(500, "INTERNAL_ERROR", "An unexpected error occurred"));
}