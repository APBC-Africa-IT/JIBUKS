/**
 * The posting engine.
 *
 * SRS: FR-ACC-01, FR-ACC-02, FR-ACC-03, FR-SYN-05, DR-04, C-04.
 *
 * This module is pure. It performs no I/O and knows nothing of HTTP or the
 * database. Every rule here is also enforced in Postgres (DR-04 requires the
 * balance rule be a database constraint, "not by application logic alone"),
 * so this is the fast, articulate first line of defence -- it produces the
 * message identifying the imbalance that FR-ACC-01 demands -- and the
 * database is the one that cannot be bypassed.
 */

import {
  DomainError,
  type AccountType,
  type CurrencyCode,
  type FieldDetail,
  type JournalInput,
  type JournalLineInput,
  type Uuid,
} from "@jibuks/domain";

/** What the engine needs to know about an account to validate a posting. */
export interface AccountSnapshot {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly code: string;
  readonly type: AccountType;
  readonly isActive: boolean;
  /** Parents in the hierarchy are grouping nodes and are not postable (FR-COA-01). */
  readonly isPostable: boolean;
  /** Null means the account accepts the tenant base currency. */
  readonly currency: CurrencyCode | null;
}

export interface PeriodSnapshot {
  readonly id: string;
  readonly tenantId: Uuid;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: "OPEN" | "CLOSED" | "LOCKED";
}

export interface PostingContext {
  readonly tenantId: Uuid;
  readonly accounts: ReadonlyMap<Uuid, AccountSnapshot>;
  readonly periods: readonly PeriodSnapshot[];
}

export interface ValidatedJournal {
  readonly input: JournalInput;
  readonly periodId: string;
  readonly totalDebitMinor: number;
  readonly totalCreditMinor: number;
}

function lineTotals(lines: readonly JournalLineInput[]): { debit: number; credit: number } {
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    debit += line.debitMinor;
    credit += line.creditMinor;
  }
  return { debit, credit };
}

function findPeriod(periods: readonly PeriodSnapshot[], date: string): PeriodSnapshot | undefined {
  return periods.find((p) => date >= p.startDate && date <= p.endDate);
}

/**
 * Validate a journal for posting. Throws DomainError on the first structural
 * failure, or on an aggregate of line-level failures.
 *
 * FR-SYN-05: an operation arriving from an offline device that breaches double
 * entry, referential integrity or a locked period is rejected outright with an
 * actionable error -- "never partially applied" (Section 3.3.3).
 */
export function validateForPosting(input: JournalInput, ctx: PostingContext): ValidatedJournal {
  if (input.tenantId !== ctx.tenantId) {
    throw new DomainError("TENANT_MISMATCH", "Journal tenant does not match the posting context");
  }

  if (input.lines.length < 2) {
    throw new DomainError(
      "JOURNAL_TOO_FEW_LINES",
      `A journal needs at least two lines to balance; received ${input.lines.length}`,
      [{ path: "lines", message: "At least two lines required" }],
    );
  }

  const details: FieldDetail[] = [];

  input.lines.forEach((line, index) => {
    const path = `lines[${index}]`;

    if (line.debitMinor > 0 && line.creditMinor > 0) {
      details.push({ path, message: "A line carries either a debit or a credit, never both" });
    }
    if (line.debitMinor === 0 && line.creditMinor === 0) {
      details.push({ path, message: "A line must carry a non-zero debit or credit" });
    }
    if (line.debitMinor < 0 || line.creditMinor < 0) {
      details.push({ path, message: "Amounts are non-negative; direction is expressed by debit or credit" });
    }
    if (!Number.isInteger(line.debitMinor) || !Number.isInteger(line.creditMinor)) {
      details.push({ path, message: "Amounts are integer minor units" });
    }

    const account = ctx.accounts.get(line.accountId);
    if (!account) {
      details.push({ path: `${path}.accountId`, message: `Account ${line.accountId} not found` });
      return;
    }
    if (account.tenantId !== ctx.tenantId) {
      details.push({ path: `${path}.accountId`, message: "Account belongs to another tenant" });
    }
    if (!account.isActive) {
      details.push({ path: `${path}.accountId`, message: `Account ${account.code} is deactivated and cannot be posted to` });
    }
    if (!account.isPostable) {
      details.push({ path: `${path}.accountId`, message: `Account ${account.code} is a grouping account; post to one of its children` });
    }
    if (account.currency !== null && account.currency !== input.currency) {
      details.push({
        path: `${path}.accountId`,
        message: `Account ${account.code} is denominated in ${account.currency}, journal is in ${input.currency}`,
      });
    }
  });

  if (details.length > 0) {
    const first = details[0]!;
    const code = first.message.includes("not found")
      ? "ACCOUNT_NOT_FOUND"
      : first.message.includes("deactivated")
        ? "ACCOUNT_INACTIVE"
        : first.message.includes("grouping")
          ? "ACCOUNT_NOT_POSTABLE"
          : first.message.includes("both")
            ? "JOURNAL_LINE_AMBIGUOUS"
            : "JOURNAL_LINE_EMPTY";
    throw new DomainError(code, `Journal has ${details.length} invalid line(s): ${first.message}`, details);
  }

  const { debit, credit } = lineTotals(input.lines);
  if (debit !== credit) {
    const difference = debit - credit;
    throw new DomainError(
      "JOURNAL_UNBALANCED",
      `Journal does not balance in ${input.currency}: debits ${debit} minor units, credits ${credit} minor units, ` +
        `difference ${Math.abs(difference)} ${difference > 0 ? "excess debit" : "excess credit"}`,
      [
        { path: "lines", message: `Total debits ${debit}` },
        { path: "lines", message: `Total credits ${credit}` },
      ],
    );
  }

  const period = findPeriod(ctx.periods, input.date);
  if (!period) {
    throw new DomainError("PERIOD_NOT_FOUND", `No accounting period covers ${input.date}`, [
      { path: "date", message: "Open a period covering this date before posting" },
    ]);
  }
  if (period.status !== "OPEN") {
    throw new DomainError("PERIOD_LOCKED", `The period containing ${input.date} is ${period.status.toLowerCase()}`, [
      { path: "date", message: "Reopening a closed period requires a named permission and is audited" },
    ]);
  }

  return { input, periodId: period.id, totalDebitMinor: debit, totalCreditMinor: credit };
}