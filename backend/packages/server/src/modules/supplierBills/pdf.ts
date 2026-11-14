/**
 * Bill and debit note PDF -- the business's own copy of what it owes a
 * supplier, laid out by the invoice renderer (../invoices/pdf.ts) with the
 * supplier where the customer would be. Generated on request, never stored.
 */

import type { InvoiceViewStatus } from "@jibuks/domain";
import { formatAmount, formatDate, formatQuantity, partyLines, type InvoicePdfModel, type PdfParty } from "../invoices/pdf.js";
import type { BillDetailView } from "./service.js";

export interface BillPdfInput {
  readonly bill: BillDetailView;
  readonly business: PdfParty;
  readonly supplier: PdfParty;
  /** The debited bill's number, for a debit note. */
  readonly debitedBillNumber?: string | null;
}

const STATUS_LABELS: Readonly<Record<InvoiceViewStatus, string>> = {
  DRAFT: "Draft",
  ISSUED: "Posted",
  PART_PAID: "Part paid",
  PAID: "Paid",
  OVERDUE: "Overdue",
  CANCELLED: "Cancelled",
};

const METHOD_LABELS: Readonly<Record<string, string>> = {
  CASH: "Cash",
  BANK: "Bank",
  MPESA: "M-Pesa",
  OTHER: "Other",
  DEBIT_NOTE: "Debit note",
};

export function buildBillPdfModel(input: BillPdfInput): InvoicePdfModel {
  const { bill } = input;
  const money = (minor: string | number) => formatAmount(minor, bill.currency);
  const isBill = bill.kind === "BILL";
  const inclusive = bill.tax_mode === "INCLUSIVE";
  const taxed = bill.tax_mode !== "NONE";

  const meta: Array<[string, string]> = [[isBill ? "Bill date" : "Date", formatDate(bill.bill_date)]];
  if (isBill && bill.due_date) {
    meta.push(["Due date", formatDate(bill.due_date)]);
  }
  if (bill.supplier_reference) {
    meta.push(["Supplier invoice", bill.supplier_reference]);
  }
  if (!isBill && input.debitedBillNumber) {
    meta.push(["Debits bill", input.debitedBillNumber]);
  }
  if (bill.reference) {
    meta.push(["Reference", bill.reference]);
  }
  if (isBill) {
    meta.push(["Status", STATUS_LABELS[bill.status]]);
  }

  const totals: Array<[string, string]> = [];
  if (taxed) {
    totals.push(["Subtotal (excl. VAT)", money(bill.subtotal_minor)], ["VAT", money(bill.tax_minor)]);
  }
  totals.push([isBill ? "Total" : "Total debit", money(bill.total_minor)]);

  let highlight: [string, string];
  if (isBill && bill.status !== "DRAFT" && bill.status !== "CANCELLED") {
    totals.push(["Paid / debited", money(bill.amount_paid_minor)]);
    highlight = ["Balance due", money(bill.balance_due_minor)];
  } else {
    highlight = totals.pop()!;
  }

  let stamp: string | null = null;
  if (bill.status === "DRAFT") stamp = "DRAFT";
  else if (bill.status === "CANCELLED") stamp = "CANCELLED";
  else if (isBill && bill.status === "PAID") stamp = "PAID";

  return {
    title: isBill ? "BILL" : "DEBIT NOTE",
    number: bill.number ?? "DRAFT",
    stamp,
    business: partyLines(input.business),
    partyLabel: "SUPPLIER",
    billTo: partyLines(input.supplier),
    shipTo: null,
    meta,
    amountHeader: inclusive ? "Amount (incl. VAT)" : "Amount",
    lines: bill.lines.map((line) => ({
      description: line.description,
      quantity: formatQuantity(line.quantity),
      unitPrice: money(line.unit_price_minor),
      vat: taxed && line.tax_rate_bps > 0 ? `${line.tax_rate_bps / 100}%` : "-",
      amount: money(inclusive ? line.total_minor : line.net_minor),
    })),
    totals,
    highlight,
    payments: bill.allocations
      .filter((a) => Number(a.amount_minor) > 0)
      .map((a) => ({
        date: formatDate(a.date),
        method: METHOD_LABELS[a.method] ?? a.method,
        reference: a.reference ?? "",
        amount: money(a.amount_minor),
      })),
    notes: bill.notes,
    filename: `${bill.number ?? `DRAFT-${bill.id.slice(0, 8)}`}.pdf`,
  };
}
