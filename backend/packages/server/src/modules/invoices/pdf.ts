/**
 * Invoice PDF (FR-AR-02 "share by PDF").
 *
 * Two steps, kept apart so the content can be tested without parsing a PDF:
 *   buildInvoicePdfModel  -- every string that goes on the page
 *   renderInvoicePdf      -- lays that model out with pdfkit (A4, built-in
 *                            Helvetica, so no font files or browser needed)
 *
 * Generated on request, never stored. Amounts come from the invoice as
 * issued; business and customer details are their current values.
 */

import PDFDocument from "pdfkit";
import type { CurrencyCode, InvoiceKind, InvoiceViewStatus } from "@jibuks/domain";
import { formatMajor } from "@jibuks/domain";
import type { InvoiceDetailView } from "./service.js";

export interface PdfParty {
  readonly name: string;
  readonly taxIdentifier: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly address?: string | null;
}

export interface InvoicePdfInput {
  readonly invoice: InvoiceDetailView;
  readonly business: PdfParty;
  readonly customer: PdfParty;
  /** The credited invoice's number, for a credit note. */
  readonly creditedInvoiceNumber?: string | null;
}

export interface InvoicePdfModel {
  readonly title: string;
  readonly number: string;
  /** Large diagonal stamp: PAID, CANCELLED, DRAFT -- or null. */
  readonly stamp: string | null;
  readonly business: string[];
  readonly billTo: string[];
  /** [label, value] pairs under the title. */
  readonly meta: Array<[string, string]>;
  readonly amountHeader: string;
  readonly lines: Array<{ description: string; quantity: string; unitPrice: string; vat: string; amount: string }>;
  readonly totals: Array<[string, string]>;
  /** The figure printed in bold at the foot of the totals. */
  readonly highlight: [string, string];
  readonly payments: Array<{ date: string; method: string; reference: string; amount: string }>;
  readonly notes: string | null;
  readonly filename: string;
}

const TITLES: Readonly<Record<InvoiceKind, string>> = {
  INVOICE: "INVOICE",
  CREDIT_NOTE: "CREDIT NOTE",
  PROFORMA: "PRO-FORMA INVOICE",
  BILL: "BILL",
  DEBIT_NOTE: "DEBIT NOTE",
};

const STATUS_LABELS: Readonly<Record<InvoiceViewStatus, string>> = {
  DRAFT: "Draft",
  ISSUED: "Issued",
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
  CREDIT_NOTE: "Credit note",
};

/** "KES 12,345.60" from a minor-unit string. */
export function formatAmount(minor: string | number, currency: string): string {
  const plain = formatMajor({ minor: Number(minor), currency: currency as CurrencyCode });
  const [whole, fraction] = plain.split(".");
  const negative = whole!.startsWith("-");
  const digits = negative ? whole!.slice(1) : whole!;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${currency} ${negative ? "-" : ""}${grouped}${fraction !== undefined ? `.${fraction}` : ""}`;
}

/** "2026-10-07" -> "7 Oct 2026". */
export function formatDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(d);
}

/** "1.500" -> "1.5", "10.000" -> "10". */
function formatQuantity(quantity: string): string {
  return quantity.includes(".") ? quantity.replace(/\.?0+$/, "") : quantity;
}

function partyLines(party: PdfParty): string[] {
  return [
    party.name,
    ...(party.address ? [party.address] : []),
    ...(party.phone ? [`Tel: ${party.phone}`] : []),
    ...(party.email ? [party.email] : []),
    ...(party.taxIdentifier ? [`PIN: ${party.taxIdentifier}`] : []),
  ];
}

export function buildInvoicePdfModel(input: InvoicePdfInput): InvoicePdfModel {
  const { invoice } = input;
  const money = (minor: string | number) => formatAmount(minor, invoice.currency);
  const number = invoice.number ?? "DRAFT";
  const inclusive = invoice.tax_mode === "INCLUSIVE";
  const taxed = invoice.tax_mode !== "NONE";

  const meta: Array<[string, string]> = [
    [invoice.kind === "PROFORMA" ? "Date" : "Issue date", formatDate(invoice.issue_date)],
  ];
  if (invoice.due_date) {
    meta.push([invoice.kind === "PROFORMA" ? "Valid until" : "Due date", formatDate(invoice.due_date)]);
  }
  if (invoice.kind === "CREDIT_NOTE" && input.creditedInvoiceNumber) {
    meta.push(["Credits invoice", input.creditedInvoiceNumber]);
  }
  if (invoice.reference) {
    meta.push(["Reference", invoice.reference]);
  }
  if (invoice.kind === "INVOICE") {
    meta.push(["Status", STATUS_LABELS[invoice.status]]);
  }

  const totals: Array<[string, string]> = [];
  if (taxed) {
    totals.push(["Subtotal (excl. VAT)", money(invoice.subtotal_minor)], ["VAT", money(invoice.tax_minor)]);
  }
  totals.push([invoice.kind === "CREDIT_NOTE" ? "Total credit" : "Total", money(invoice.total_minor)]);

  let highlight: [string, string];
  if (invoice.kind === "INVOICE" && invoice.status !== "DRAFT" && invoice.status !== "CANCELLED") {
    totals.push(["Paid / credited", money(invoice.amount_paid_minor)]);
    highlight = ["Balance due", money(invoice.balance_due_minor)];
  } else {
    highlight = totals.pop()!;
  }

  let stamp: string | null = null;
  if (invoice.status === "DRAFT") stamp = "DRAFT";
  else if (invoice.status === "CANCELLED") stamp = "CANCELLED";
  else if (invoice.kind === "INVOICE" && invoice.status === "PAID") stamp = "PAID";

  return {
    title: TITLES[invoice.kind],
    number,
    stamp,
    business: partyLines(input.business),
    billTo: partyLines(input.customer),
    meta,
    amountHeader: inclusive ? "Amount (incl. VAT)" : "Amount",
    lines: invoice.lines.map((line) => {
      const amount = inclusive ? line.total_minor : line.net_minor;
      return {
        description: line.description,
        quantity: formatQuantity(line.quantity),
        unitPrice: money(line.unit_price_minor),
        vat: taxed && line.tax_rate_bps > 0 ? `${line.tax_rate_bps / 100}%` : "-",
        amount: money(amount),
      };
    }),
    totals,
    highlight,
    payments: invoice.allocations
      .filter((a) => Number(a.amount_minor) > 0)
      .map((a) => ({
        date: formatDate(a.date),
        method: METHOD_LABELS[a.method] ?? a.method,
        reference: a.reference ?? "",
        amount: money(a.amount_minor),
      })),
    notes: invoice.notes,
    filename: `${invoice.number ?? `DRAFT-${invoice.id.slice(0, 8)}`}.pdf`,
  };
}

// ---------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------

const PAGE_MARGIN = 50;
const INK = "#1f2933";
const MUTED = "#6b7785";
const RULE = "#d5dbe1";
const ACCENT = "#0b6e4f";

/** Column x positions and widths for the line table (A4: 595pt wide, 495 usable). */
const COLUMNS = {
  description: { x: 50, width: 205 },
  quantity: { x: 255, width: 45 },
  unitPrice: { x: 300, width: 85 },
  vat: { x: 385, width: 35 },
  amount: { x: 420, width: 125 },
} as const;

export function renderInvoicePdf(model: InvoicePdfModel): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margin: PAGE_MARGIN,
    bufferPages: true, // footers and the stamp are drawn after the body
    info: { Title: `${model.title} ${model.number}`, Producer: "JiBUks", Creator: "JiBUks" },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const right = doc.page.width - PAGE_MARGIN;
  const usable = right - PAGE_MARGIN;

  // Header: business on the left, title and number on the right.
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(14).text(model.business[0] ?? "", PAGE_MARGIN, PAGE_MARGIN, {
    width: usable / 2,
  });
  doc.font("Helvetica").fontSize(9).fillColor(MUTED);
  for (const line of model.business.slice(1)) {
    doc.text(line, { width: usable / 2 });
  }
  const headerBottom = doc.y;

  doc.font("Helvetica-Bold").fontSize(20).fillColor(ACCENT).text(model.title, PAGE_MARGIN, PAGE_MARGIN, {
    width: usable,
    align: "right",
  });
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(model.number, { width: usable, align: "right" });
  // Label / value pairs in two fixed right-hand columns.
  let metaY = doc.y + 6;
  doc.font("Helvetica").fontSize(9);
  const valueWidth = 95;
  const labelRight = right - valueWidth - 8;
  for (const [label, value] of model.meta) {
    doc.fillColor(MUTED).text(label, labelRight - 100, metaY, { width: 100, align: "right" });
    doc.fillColor(INK).text(value, right - valueWidth, metaY, { width: valueWidth, align: "right" });
    metaY += 13;
  }
  doc.y = metaY;

  // Bill to.
  let y = Math.max(headerBottom, doc.y) + 25;
  doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text("BILL TO", PAGE_MARGIN, y);
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(model.billTo[0] ?? "");
  doc.font("Helvetica").fontSize(9).fillColor(INK);
  for (const line of model.billTo.slice(1)) {
    doc.text(line);
  }

  // Line table.
  y = doc.y + 20;
  const headerRow = (top: number) => {
    doc.rect(PAGE_MARGIN, top - 5, usable, 18).fill("#f1f4f6");
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED);
    doc.text("DESCRIPTION", COLUMNS.description.x + 4, top, { width: COLUMNS.description.width - 8 });
    doc.text("QTY", COLUMNS.quantity.x, top, { width: COLUMNS.quantity.width, align: "right" });
    doc.text("UNIT PRICE", COLUMNS.unitPrice.x, top, { width: COLUMNS.unitPrice.width, align: "right" });
    doc.text("VAT", COLUMNS.vat.x, top, { width: COLUMNS.vat.width, align: "right" });
    doc.text(model.amountHeader.toUpperCase(), COLUMNS.amount.x, top, { width: COLUMNS.amount.width - 4, align: "right" });
    return top + 20;
  };
  y = headerRow(y);

  doc.font("Helvetica").fontSize(9).fillColor(INK);
  for (const line of model.lines) {
    const height = Math.max(doc.heightOfString(line.description, { width: COLUMNS.description.width - 8 }), 11);
    if (y + height > doc.page.height - PAGE_MARGIN - 60) {
      doc.addPage();
      y = headerRow(PAGE_MARGIN);
      doc.font("Helvetica").fontSize(9).fillColor(INK);
    }
    doc.text(line.description, COLUMNS.description.x + 4, y, { width: COLUMNS.description.width - 8 });
    doc.text(line.quantity, COLUMNS.quantity.x, y, { width: COLUMNS.quantity.width, align: "right" });
    doc.text(line.unitPrice, COLUMNS.unitPrice.x, y, { width: COLUMNS.unitPrice.width, align: "right" });
    doc.text(line.vat, COLUMNS.vat.x, y, { width: COLUMNS.vat.width, align: "right" });
    doc.text(line.amount, COLUMNS.amount.x, y, { width: COLUMNS.amount.width - 4, align: "right" });
    y += height + 6;
    doc.moveTo(PAGE_MARGIN, y - 3).lineTo(right, y - 3).lineWidth(0.5).strokeColor(RULE).stroke();
  }

  /** Starts a new page when `height` more points won't fit above the footer. */
  const ensureSpace = (height: number) => {
    if (y + height > doc.page.height - PAGE_MARGIN - 20) {
      doc.addPage();
      y = PAGE_MARGIN;
    }
  };

  // Totals, right-aligned under the table.
  y += 8;
  ensureSpace(model.totals.length * 15 + 40);
  const labelX = 300;
  const labelWidth = 150;
  const valueX = labelX + labelWidth;
  const totalsValueWidth = right - valueX - 4;
  doc.font("Helvetica").fontSize(9);
  for (const [label, value] of model.totals) {
    doc.fillColor(MUTED).text(label, labelX, y, { width: labelWidth });
    doc.fillColor(INK).text(value, valueX, y, { width: totalsValueWidth, align: "right" });
    y += 15;
  }
  doc.moveTo(labelX, y).lineTo(right, y).lineWidth(1).strokeColor(INK).stroke();
  y += 6;
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK);
  doc.text(model.highlight[0], labelX, y, { width: labelWidth });
  doc.text(model.highlight[1], valueX - 40, y, { width: totalsValueWidth + 40, align: "right" });
  y += 25;

  // Payments received.
  if (model.payments.length > 0) {
    ensureSpace(model.payments.length * 14 + 30);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text("PAYMENTS AND CREDITS", PAGE_MARGIN, y);
    y = doc.y + 4;
    doc.font("Helvetica").fontSize(9).fillColor(INK);
    for (const p of model.payments) {
      doc.text(`${p.date}   ${p.method}${p.reference ? `   ${p.reference}` : ""}`, PAGE_MARGIN, y, { width: 300 });
      doc.text(p.amount, valueX - 40, y, { width: totalsValueWidth + 40, align: "right" });
      y += 14;
    }
    y += 10;
  }

  if (model.notes) {
    ensureSpace(40);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text("NOTES", PAGE_MARGIN, y);
    doc.font("Helvetica").fontSize(9).fillColor(INK).text(model.notes, { width: usable });
  }

  // Stamp across the first page, drawn last so it sits on top.
  if (model.stamp) {
    doc.switchToPage(0);
    doc.save();
    doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc
      .font("Helvetica-Bold")
      .fontSize(72)
      .fillColor(model.stamp === "PAID" ? ACCENT : "#b42318")
      .opacity(0.12)
      .text(model.stamp, 0, doc.page.height / 2 - 40, { width: doc.page.width, align: "center", lineBreak: false });
    doc.restore();
  }

  // Footer on every page.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // the footer sits in the margin; don't let it start a new page
    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor(MUTED)
      .opacity(1)
      .text(`${model.title} ${model.number} · page ${i + 1} of ${range.count} · prepared with JiBUks`, PAGE_MARGIN, doc.page.height - 35, {
        width: usable,
        align: "center",
        lineBreak: false,
      });
  }

  doc.end();
  return done;
}
