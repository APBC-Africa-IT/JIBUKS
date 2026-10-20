/**
 * Statement PDF. Same two steps as the invoice PDF (invoices/pdf.ts):
 *   buildStatementPdfModel -- every string that goes on the page
 *   renderStatementPdf     -- lays it out with pdfkit (A4, Helvetica)
 *
 * Amounts come from the stored snapshot; business and customer details are
 * their current values. Generated on request, never stored.
 */

import PDFDocument from "pdfkit";
import { AGING_BUCKETS } from "@jibuks/domain";
import type { CustomerTransaction } from "../customerLedger/service.js";
import { formatAmount, formatDate, type PdfParty } from "../invoices/pdf.js";
import type { StatementDetailView } from "./service.js";

export interface StatementPdfInput {
  readonly statement: StatementDetailView;
  /** The statement's currency, the base currency filled in. */
  readonly currency: string;
  readonly business: PdfParty;
  readonly customer: PdfParty;
}

export interface StatementPdfModel {
  readonly number: string;
  readonly business: string[];
  readonly customer: string[];
  readonly meta: Array<[string, string]>;
  /** The first row is the balance brought forward. */
  readonly rows: Array<{ date: string; details: string; charges: string; payments: string; balance: string }>;
  readonly totals: Array<[string, string]>;
  readonly highlight: [string, string];
  readonly aging: Array<[string, string]>;
  readonly message: string | null;
  readonly filename: string;
}

const METHOD_LABELS: Readonly<Record<string, string>> = {
  CASH: "Cash",
  BANK: "Bank",
  MPESA: "M-Pesa",
  OTHER: "Other",
};

const BUCKET_LABELS: Readonly<Record<string, string>> = {
  CURRENT: "Current",
  DAYS_1_30: "1-30 days",
  DAYS_31_60: "31-60 days",
  DAYS_61_90: "61-90 days",
  DAYS_OVER_90: "Over 90 days",
};

/** What the customer reads on a row: "Invoice INV-000124", "Payment (M-Pesa QAB12CD34E) - INV-000124". */
export function describeTransaction(t: CustomerTransaction): string {
  switch (t.type) {
    case "OPENING_BALANCE":
      return "Opening balance";
    case "INVOICE":
      return `Invoice ${t.document_number ?? ""}`.trim();
    case "CREDIT_NOTE":
      return `Credit note ${t.document_number ?? ""}${t.credited_invoice_number ? ` - ${t.credited_invoice_number}` : ""}`;
    case "INVOICE_CANCELLED":
      return `Invoice ${t.document_number ?? ""} cancelled`;
    case "CREDIT_NOTE_CANCELLED":
      return `Credit note ${t.document_number ?? ""} cancelled`;
    case "PAYMENT": {
      const how = [t.payment_method ? METHOD_LABELS[t.payment_method] : null, t.reference].filter(Boolean).join(" ");
      return `Payment${how ? ` (${how})` : ""}${t.document_number ? ` - ${t.document_number}` : ""}`;
    }
    case "CREDIT_SALE":
      return `Credit sale${t.reference ? ` ${t.reference}` : ""}`;
    default:
      return t.description;
  }
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

export function buildStatementPdfModel(input: StatementPdfInput): StatementPdfModel {
  const { statement, currency } = input;
  const money = (minor: string | number) => formatAmount(minor, currency);
  const closing = Number(statement.closing_balance_minor);

  return {
    number: statement.number,
    business: partyLines(input.business),
    customer: partyLines(input.customer),
    meta: [
      ["Statement date", formatDate(statement.period_to)],
      ["Period", `${formatDate(statement.period_from)} - ${formatDate(statement.period_to)}`],
    ],
    rows: [
      {
        date: formatDate(statement.period_from),
        details: "Balance brought forward",
        charges: "",
        payments: "",
        balance: money(statement.opening_balance_minor),
      },
      ...statement.transactions.map((t) => ({
        date: formatDate(t.date),
        details: describeTransaction(t),
        charges: Number(t.debit_minor) > 0 ? money(t.debit_minor) : "",
        payments: Number(t.credit_minor) > 0 ? money(t.credit_minor) : "",
        balance: money(t.balance_minor),
      })),
    ],
    totals: [
      ["Opening balance", money(statement.opening_balance_minor)],
      ["Invoices and charges", money(statement.total_debit_minor)],
      ["Payments and credits", money(statement.total_credit_minor)],
    ],
    highlight: closing < 0 ? ["Credit balance", money(-closing)] : ["Amount due", money(closing)],
    aging: [
      ...AGING_BUCKETS.map((b): [string, string] => [BUCKET_LABELS[b]!, money(statement.aging[`${b.toLowerCase()}_minor`] ?? "0")]),
      ...(Number(statement.aging["not_invoiced_minor"] ?? "0") !== 0
        ? [["Not invoiced", money(statement.aging["not_invoiced_minor"]!)] as [string, string]]
        : []),
    ],
    message: statement.message,
    filename: `${statement.number}.pdf`,
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

/** Column x positions and widths for the transactions table (A4: 495pt usable). */
const COLUMNS = {
  date: { x: 50, width: 65 },
  details: { x: 115, width: 190 },
  charges: { x: 305, width: 80 },
  payments: { x: 385, width: 80 },
  balance: { x: 465, width: 80 },
} as const;

export function renderStatementPdf(model: StatementPdfModel): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margin: PAGE_MARGIN,
    bufferPages: true, // footers are drawn after the body
    info: { Title: `STATEMENT ${model.number}`, Producer: "JiBUks", Creator: "JiBUks" },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const right = doc.page.width - PAGE_MARGIN;
  const usable = right - PAGE_MARGIN;

  // Header: business on the left, title, number and dates on the right.
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(14).text(model.business[0] ?? "", PAGE_MARGIN, PAGE_MARGIN, {
    width: usable / 2,
  });
  doc.font("Helvetica").fontSize(9).fillColor(MUTED);
  for (const line of model.business.slice(1)) {
    doc.text(line, { width: usable / 2 });
  }
  const headerBottom = doc.y;

  doc.font("Helvetica-Bold").fontSize(20).fillColor(ACCENT).text("STATEMENT", PAGE_MARGIN, PAGE_MARGIN, {
    width: usable,
    align: "right",
  });
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(model.number, { width: usable, align: "right" });
  let metaY = doc.y + 6;
  doc.font("Helvetica").fontSize(9);
  const valueWidth = 150;
  for (const [label, value] of model.meta) {
    doc.fillColor(MUTED).text(label, right - valueWidth - 108, metaY, { width: 100, align: "right" });
    doc.fillColor(INK).text(value, right - valueWidth, metaY, { width: valueWidth, align: "right" });
    metaY += 13;
  }

  // Customer.
  let y = Math.max(headerBottom, metaY) + 25;
  doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text("STATEMENT FOR", PAGE_MARGIN, y);
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(model.customer[0] ?? "");
  doc.font("Helvetica").fontSize(9).fillColor(INK);
  for (const line of model.customer.slice(1)) {
    doc.text(line);
  }

  // Transactions.
  y = doc.y + 20;
  const headerRow = (top: number) => {
    doc.rect(PAGE_MARGIN, top - 5, usable, 18).fill("#f1f4f6");
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED);
    doc.text("DATE", COLUMNS.date.x + 4, top, { width: COLUMNS.date.width - 4 });
    doc.text("DETAILS", COLUMNS.details.x, top, { width: COLUMNS.details.width });
    doc.text("CHARGES", COLUMNS.charges.x, top, { width: COLUMNS.charges.width, align: "right" });
    doc.text("PAYMENTS", COLUMNS.payments.x, top, { width: COLUMNS.payments.width, align: "right" });
    doc.text("BALANCE", COLUMNS.balance.x, top, { width: COLUMNS.balance.width - 4, align: "right" });
    return top + 20;
  };
  y = headerRow(y);

  doc.font("Helvetica").fontSize(9).fillColor(INK);
  for (const row of model.rows) {
    const height = Math.max(doc.heightOfString(row.details, { width: COLUMNS.details.width }), 11);
    if (y + height > doc.page.height - PAGE_MARGIN - 60) {
      doc.addPage();
      y = headerRow(PAGE_MARGIN);
      doc.font("Helvetica").fontSize(9).fillColor(INK);
    }
    doc.text(row.date, COLUMNS.date.x + 4, y, { width: COLUMNS.date.width - 4 });
    doc.text(row.details, COLUMNS.details.x, y, { width: COLUMNS.details.width });
    doc.text(row.charges, COLUMNS.charges.x, y, { width: COLUMNS.charges.width, align: "right" });
    doc.text(row.payments, COLUMNS.payments.x, y, { width: COLUMNS.payments.width, align: "right" });
    doc.text(row.balance, COLUMNS.balance.x, y, { width: COLUMNS.balance.width - 4, align: "right" });
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
    doc.fillColor(INK).text(value, valueX - 40, y, { width: totalsValueWidth + 40, align: "right" });
    y += 15;
  }
  doc.moveTo(labelX, y).lineTo(right, y).lineWidth(1).strokeColor(INK).stroke();
  y += 6;
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK);
  doc.text(model.highlight[0], labelX, y, { width: labelWidth });
  doc.text(model.highlight[1], valueX - 40, y, { width: totalsValueWidth + 40, align: "right" });
  y += 30;

  // Aging: one box per bucket across the page.
  ensureSpace(50);
  doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text("AMOUNT DUE BY AGE", PAGE_MARGIN, y);
  y = doc.y + 4;
  const cell = usable / model.aging.length;
  model.aging.forEach(([label, value], i) => {
    const x = PAGE_MARGIN + i * cell;
    doc.rect(x, y, cell, 32).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.font("Helvetica").fontSize(7).fillColor(MUTED).text(label, x, y + 5, { width: cell, align: "center" });
    doc.font("Helvetica-Bold").fontSize(8).fillColor(INK).text(value, x, y + 17, { width: cell, align: "center" });
  });
  y += 45;

  if (model.message) {
    ensureSpace(40);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text("MESSAGE", PAGE_MARGIN, y);
    doc.font("Helvetica").fontSize(9).fillColor(INK).text(model.message, { width: usable });
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
      .text(`STATEMENT ${model.number} · page ${i + 1} of ${range.count} · prepared with JiBUks`, PAGE_MARGIN, doc.page.height - 35, {
        width: usable,
        align: "center",
        lineBreak: false,
      });
  }

  doc.end();
  return done;
}
