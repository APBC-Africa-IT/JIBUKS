/**
 * Tests for invoices.ts -- the line and total arithmetic the server stores
 * and posts, and clients use to preview (FR-TAX-01).
 */

import { describe, expect, it } from "vitest";
import { computeInvoiceLine, computeInvoiceTotals, formatInvoiceNumber, invoiceViewStatus } from "../src/index.js";

describe("computeInvoiceLine", () => {
  it("adds exclusive tax on top, rounding half up", () => {
    // 1 x 0.05 at 16% = 0.008 -> 0.01
    expect(computeInvoiceLine({ quantity: 1, unitPriceMinor: 5, taxRateBps: 1600 }, "EXCLUSIVE")).toEqual({
      netMinor: 5,
      taxMinor: 1,
      totalMinor: 6,
    });
  });

  it("extracts inclusive tax so net + tax equals the price exactly", () => {
    expect(computeInvoiceLine({ quantity: 1, unitPriceMinor: 6500, taxRateBps: 1600 }, "INCLUSIVE")).toEqual({
      netMinor: 5603,
      taxMinor: 897,
      totalMinor: 6500,
    });
  });

  it("multiplies fractional quantities exactly before rounding once", () => {
    // 2.345 x 33.33 = 78.15885 -> 78.16
    expect(computeInvoiceLine({ quantity: 2.345, unitPriceMinor: 3333, taxRateBps: 0 }, "NONE").netMinor).toBe(7816);
  });

  it("ignores rates under NONE and rejects more than three decimal places", () => {
    expect(computeInvoiceLine({ quantity: 1, unitPriceMinor: 100, taxRateBps: 1600 }, "NONE").taxMinor).toBe(0);
    expect(() => computeInvoiceLine({ quantity: 1.0001, unitPriceMinor: 100, taxRateBps: 0 }, "NONE")).toThrow(
      /three decimal places/,
    );
  });
});

describe("computeInvoiceTotals", () => {
  it("sums the rounded lines", () => {
    const totals = computeInvoiceTotals(
      [
        { quantity: 3, unitPriceMinor: 15050, taxRateBps: 1600 },
        { quantity: 1, unitPriceMinor: 20000, taxRateBps: 0 },
      ],
      "EXCLUSIVE",
    );
    expect(totals).toMatchObject({ subtotalMinor: 65150, taxMinor: 7224, totalMinor: 72374 });
  });
});

describe("numbers and statuses", () => {
  it("formats numbers per kind", () => {
    expect(formatInvoiceNumber("INVOICE", 42)).toBe("INV-000042");
    expect(formatInvoiceNumber("CREDIT_NOTE", 1234567)).toBe("CN-1234567");
  });

  it("derives OVERDUE only for unpaid issued invoices past due", () => {
    expect(invoiceViewStatus("INVOICE", "ISSUED", "2026-10-01", "2026-10-02")).toBe("OVERDUE");
    expect(invoiceViewStatus("INVOICE", "PART_PAID", "2026-10-02", "2026-10-02")).toBe("PART_PAID");
    expect(invoiceViewStatus("INVOICE", "PAID", "2026-10-01", "2026-10-02")).toBe("PAID");
    expect(invoiceViewStatus("PROFORMA", "ISSUED", "2026-10-01", "2026-10-02")).toBe("ISSUED");
  });
});

describe("aging buckets", () => {
  it("counts whole days past due and bands them", async () => {
    const { agingBucket, daysPastDue } = await import("../src/index.js");
    expect(daysPastDue("2026-10-01", "2026-10-01")).toBe(0);
    expect(daysPastDue("2026-10-01", "2026-09-30")).toBe(-1);
    expect(daysPastDue("2026-02-28", "2026-03-30")).toBe(30);
    expect([0, 1, 30, 31, 60, 61, 90, 91].map(agingBucket)).toEqual([
      "CURRENT",
      "DAYS_1_30",
      "DAYS_1_30",
      "DAYS_31_60",
      "DAYS_31_60",
      "DAYS_61_90",
      "DAYS_61_90",
      "DAYS_OVER_90",
    ]);
  });
});
