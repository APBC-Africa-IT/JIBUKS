/**
 * What goes on a bill / debit note PDF (buildBillPdfModel) -- tested as
 * plain strings. The HTTP endpoint is covered in supplierBills.test.ts.
 */

import { describe, expect, it } from "vitest";
import { renderInvoicePdf } from "../src/modules/invoices/pdf.js";
import { buildBillPdfModel } from "../src/modules/supplierBills/pdf.js";
import type { BillDetailView } from "../src/modules/supplierBills/service.js";

function bill(overrides: Partial<BillDetailView> = {}): BillDetailView {
  return {
    id: "7a1e2d3c-0000-4000-8000-000000000000",
    kind: "BILL",
    status: "PART_PAID",
    number: "BILL-000004",
    supplier_reference: "KQ-5521",
    bill_date: "2026-11-02",
    due_date: "2026-11-16",
    currency: "KES",
    tax_mode: "EXCLUSIVE",
    subtotal_minor: "1200000",
    tax_minor: "192000",
    total_minor: "1392000",
    amount_paid_minor: "392000",
    balance_due_minor: "1000000",
    reference: null,
    notes: null,
    debited_bill_id: null,
    lines: [
      {
        description: "Maize 90kg bags",
        quantity: "4.000",
        unit_price_minor: "300000",
        tax_rate_bps: 1600,
        net_minor: "1200000",
        tax_minor: "192000",
        total_minor: "1392000",
      },
    ],
    allocations: [{ method: "BANK", amount_minor: "392000", date: "2026-11-05", reference: "CHQ 0012" }],
    ...overrides,
  } as unknown as BillDetailView;
}

const business = { name: "Mama Njeri Shop", taxIdentifier: "P051234567X" };
const supplier = { name: "Unga Millers Ltd", taxIdentifier: "P000111222Z", phone: "0722000111", email: null, address: "Industrial Area, Nairobi" };

describe("buildBillPdfModel", () => {
  it("puts the supplier under SUPPLIER, their invoice number in the meta, and the balance due", () => {
    const model = buildBillPdfModel({ bill: bill(), business, supplier });

    expect(model).toMatchObject({ title: "BILL", number: "BILL-000004", stamp: null, partyLabel: "SUPPLIER", filename: "BILL-000004.pdf" });
    expect(model.billTo).toEqual(["Unga Millers Ltd", "Industrial Area, Nairobi", "Tel: 0722000111", "PIN: P000111222Z"]);
    expect(model.meta).toEqual([
      ["Bill date", "2 Nov 2026"],
      ["Due date", "16 Nov 2026"],
      ["Supplier invoice", "KQ-5521"],
      ["Status", "Part paid"],
    ]);
    expect(model.lines[0]).toEqual({ description: "Maize 90kg bags", quantity: "4", unitPrice: "KES 3,000.00", vat: "16%", amount: "KES 12,000.00" });
    expect(model.totals).toEqual([
      ["Subtotal (excl. VAT)", "KES 12,000.00"],
      ["VAT", "KES 1,920.00"],
      ["Total", "KES 13,920.00"],
      ["Paid / debited", "KES 3,920.00"],
    ]);
    expect(model.highlight).toEqual(["Balance due", "KES 10,000.00"]);
    expect(model.payments).toEqual([{ date: "5 Nov 2026", method: "Bank", reference: "CHQ 0012", amount: "KES 3,920.00" }]);
  });

  it("stamps drafts and paid bills", () => {
    expect(buildBillPdfModel({ bill: bill({ status: "DRAFT", number: null }), business, supplier })).toMatchObject({
      stamp: "DRAFT",
      number: "DRAFT",
      filename: "DRAFT-7a1e2d3c.pdf",
      highlight: ["Total", "KES 13,920.00"],
    });
    expect(buildBillPdfModel({ bill: bill({ status: "PAID" }), business, supplier }).stamp).toBe("PAID");
  });

  it("names a debit note's bill and totals the debit", () => {
    const model = buildBillPdfModel({
      bill: bill({ kind: "DEBIT_NOTE", status: "PAID", number: "DN-000002", tax_mode: "NONE", allocations: [] }),
      business,
      supplier,
      debitedBillNumber: "BILL-000004",
    });

    expect(model.title).toBe("DEBIT NOTE");
    expect(model.stamp).toBeNull();
    expect(model.meta).toContainEqual(["Debits bill", "BILL-000004"]);
    expect(model.meta.map(([label]) => label)).not.toContain("Due date");
    expect(model.highlight).toEqual(["Total debit", "KES 13,920.00"]);
  });

  it("renders to a PDF", async () => {
    const pdf = await renderInvoicePdf(buildBillPdfModel({ bill: bill(), business, supplier }));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
