/**
 * What goes on an invoice PDF (buildInvoicePdfModel) -- tested as plain
 * strings, without parsing a PDF. renderInvoicePdf is smoke-tested here;
 * the HTTP endpoint is covered in invoices.test.ts.
 */

import { describe, expect, it } from "vitest";
import { buildInvoicePdfModel, formatAmount, formatDate, renderInvoicePdf } from "../src/modules/invoices/pdf.js";
import type { InvoiceDetailView } from "../src/modules/invoices/service.js";

function invoice(overrides: Partial<InvoiceDetailView> = {}): InvoiceDetailView {
  return {
    id: "4f1e2d3c-0000-4000-8000-000000000000",
    kind: "INVOICE",
    status: "PART_PAID",
    number: "INV-000012",
    issue_date: "2026-10-07",
    due_date: "2026-11-06",
    currency: "KES",
    tax_mode: "EXCLUSIVE",
    subtotal_minor: "250000",
    tax_minor: "40000",
    total_minor: "290000",
    amount_paid_minor: "200000",
    balance_due_minor: "90000",
    reference: "PO-778",
    notes: "Thank you",
    lines: [
      {
        line_no: 1,
        description: "Maize flour 2kg",
        quantity: "10.000",
        unit_price_minor: "25000",
        tax_rate_bps: 1600,
        net_minor: "250000",
        tax_minor: "40000",
        total_minor: "290000",
      },
    ],
    allocations: [{ method: "MPESA", amount_minor: "200000", unapplied_minor: "0", date: "2026-10-08", reference: "TIF1234ABC" }],
    ...overrides,
  } as unknown as InvoiceDetailView;
}

const business = { name: "Mama Njeri Shop", taxIdentifier: "P051234567X" };
const customer = { name: "Wanjiku Stores", taxIdentifier: null, phone: "0712345678", email: null, address: null };

describe("formatting", () => {
  it("groups thousands and keeps the currency's decimals", () => {
    expect(formatAmount("123456789", "KES")).toBe("KES 1,234,567.89");
    expect(formatAmount("1500", "UGX")).toBe("UGX 1,500");
    expect(formatAmount("5", "KES")).toBe("KES 0.05");
  });

  it("writes dates the Kenyan way", () => {
    expect(formatDate("2026-10-07")).toBe("7 Oct 2026");
  });
});

describe("buildInvoicePdfModel", () => {
  it("shows both PINs, the VAT split, payments and the balance due", () => {
    const model = buildInvoicePdfModel({ invoice: invoice(), business, customer });

    expect(model).toMatchObject({ title: "INVOICE", number: "INV-000012", stamp: null, filename: "INV-000012.pdf" });
    expect(model.business).toEqual(["Mama Njeri Shop", "PIN: P051234567X"]);
    expect(model.billTo).toEqual(["Wanjiku Stores", "Tel: 0712345678"]);
    expect(model.meta).toContainEqual(["Due date", "6 Nov 2026"]);
    expect(model.meta).toContainEqual(["Status", "Part paid"]);
    expect(model.lines[0]).toEqual({
      description: "Maize flour 2kg",
      quantity: "10",
      unitPrice: "KES 250.00",
      vat: "16%",
      amount: "KES 2,500.00",
    });
    expect(model.totals).toEqual([
      ["Subtotal (excl. VAT)", "KES 2,500.00"],
      ["VAT", "KES 400.00"],
      ["Total", "KES 2,900.00"],
      ["Paid / credited", "KES 2,000.00"],
    ]);
    expect(model.highlight).toEqual(["Balance due", "KES 900.00"]);
    expect(model.payments).toEqual([{ date: "8 Oct 2026", method: "M-Pesa", reference: "TIF1234ABC", amount: "KES 2,000.00" }]);
  });

  it("stamps PAID, CANCELLED and DRAFT", () => {
    const stamp = (overrides: Partial<InvoiceDetailView>) => buildInvoicePdfModel({ invoice: invoice(overrides), business, customer }).stamp;

    expect(stamp({ status: "PAID" })).toBe("PAID");
    expect(stamp({ status: "CANCELLED" })).toBe("CANCELLED");
    expect(stamp({ status: "DRAFT", number: null })).toBe("DRAFT");
    expect(stamp({ status: "OVERDUE" })).toBeNull();
  });

  it("titles a credit note, names the invoice it credits and ends on the total credit", () => {
    const model = buildInvoicePdfModel({
      invoice: invoice({ kind: "CREDIT_NOTE", status: "ISSUED", number: "CN-000003", due_date: null, allocations: [] }),
      business,
      customer,
      creditedInvoiceNumber: "INV-000012",
    });

    expect(model.title).toBe("CREDIT NOTE");
    expect(model.meta).toContainEqual(["Credits invoice", "INV-000012"]);
    expect(model.meta.find(([label]) => label === "Status")).toBeUndefined();
    expect(model.highlight).toEqual(["Total credit", "KES 2,900.00"]);
  });

  it("shows tax-inclusive line amounts and no VAT rows when untaxed", () => {
    const inclusive = buildInvoicePdfModel({ invoice: invoice({ tax_mode: "INCLUSIVE" }), business, customer });
    const untaxed = buildInvoicePdfModel({
      invoice: invoice({ kind: "PROFORMA", status: "ISSUED", number: "PF-000001", tax_mode: "NONE", allocations: [] }),
      business,
      customer,
    });

    expect(inclusive.amountHeader).toBe("Amount (incl. VAT)");
    expect(inclusive.lines[0]!.amount).toBe("KES 2,900.00");
    expect(untaxed.title).toBe("PRO-FORMA INVOICE");
    expect(untaxed.meta).toContainEqual(["Valid until", "6 Nov 2026"]);
    expect(untaxed.lines[0]!.vat).toBe("-");
    expect(untaxed.totals).toEqual([]);
    expect(untaxed.highlight).toEqual(["Total", "KES 2,900.00"]);
  });
});

describe("renderInvoicePdf", () => {
  it("produces a PDF, over several pages for a long invoice", async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ ...invoice().lines[0]!, line_no: i + 1, description: `Item ${i + 1}` }));
    const model = buildInvoicePdfModel({ invoice: invoice({ status: "PAID", lines: many }), business, customer });

    const pdf = await renderInvoicePdf(model);

    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.toString("latin1")).toMatch(/\/Count 3\b/);
  });
});
