/**
 * Tests for errors.ts.
 * Thin on purpose -- DomainError is a simple carrier type -- but confirms
 * the shape every other layer will rely on: code, message, details.
 */

import { describe, expect, it } from "vitest";
import { DomainError } from "../src/index.js";

describe("DomainError", () => {
  it("carries a code and message", () => {
    const err = new DomainError("JOURNAL_UNBALANCED", "Debits do not equal credits");
    expect(err.code).toBe("JOURNAL_UNBALANCED");
    expect(err.message).toBe("Debits do not equal credits");
    expect(err.name).toBe("DomainError");
  });

  it("defaults to an empty details array", () => {
    const err = new DomainError("ACCOUNT_NOT_FOUND", "No such account");
    expect(err.details).toEqual([]);
  });

  it("carries field-level details when provided", () => {
    const err = new DomainError("JOURNAL_UNBALANCED", "Does not balance", [
      { path: "lines[0].debitMinor", message: "Too high" },
    ]);
    expect(err.details).toHaveLength(1);
    expect(err.details[0]).toEqual({ path: "lines[0].debitMinor", message: "Too high" });
  });

  it("is a real Error instance, so it works with try/catch and stack traces", () => {
    const err = new DomainError("PERIOD_LOCKED", "Period is locked");
    expect(err).toBeInstanceOf(Error);
    expect(typeof err.stack).toBe("string");
  });
});