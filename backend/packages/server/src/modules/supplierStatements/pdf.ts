/**
 * Supplier statement PDF: the model for the shared statement layout
 * (customerStatements/pdf.ts renderStatementPdf), with the supplier's
 * wording -- BILLS adds to what the business owes, PAYMENTS takes off it.
 */

import { AGING_BUCKETS } from "@jibuks/domain";
import { BUCKET_LABELS, partyLines, type StatementPdfModel } from "../customerStatements/pdf.js";
import { formatAmount, formatDate, type PdfParty } from "../invoices/pdf.js";
import type { SupplierTransaction } from "../supplierLedger/service.js";
import type { SupplierStatement } from "./service.js";

const METHOD_LABELS: Readonly<Record<string, string>> = {
  CASH: "Cash",
  BANK: "Bank",
  MPESA: "M-Pesa",
  CHEQUE: "Cheque",
  OTHER: "Other",
};

function how(t: SupplierTransaction): string {
  const text = [t.payment_method ? METHOD_LABELS[t.payment_method] : null, t.reference].filter(Boolean).join(" ");
  return text ? ` (${text})` : "";
}

/** What a row reads: "Bill BILL-000031", "Payment SP-000017 (Cheque 004512) - BILL-000031, BILL-000034". */
export function describeSupplierTransaction(t: SupplierTransaction): string {
  const number = t.document_number ? ` ${t.document_number}` : "";
  switch (t.type) {
    case "OPENING_BALANCE":
      return "Opening balance";
    case "BILL":
      return t.document_number ? `Bill${number}` : t.description;
    case "DEBIT_NOTE":
      return `Debit note${number}${t.debited_bill_number ? ` - ${t.debited_bill_number}` : ""}`;
    case "BILL_CANCELLED":
      return `Bill${number} cancelled`;
    case "DEBIT_NOTE_CANCELLED":
      return `Debit note${number} cancelled`;
    case "CASH_PURCHASE":
      return `Cash purchase${number} (paid)`;
    case "PAYMENT": {
      if (t.document_kind !== "SUPPLIER_PAYMENT") {
        return t.description; // a guided POST /cheques
      }
      const paid = t.paid_bills.map((b) => b.bill_number).filter(Boolean);
      return `Payment${number}${how(t)}${paid.length > 0 ? ` - ${paid.join(", ")}` : ""}`;
    }
    case "REFUND":
      return `Refund received${number}${how(t)}`;
    default:
      return t.description;
  }
}

export interface SupplierStatementPdfInput {
  readonly statement: SupplierStatement;
  readonly business: PdfParty;
  readonly supplier: PdfParty;
}

export function buildSupplierStatementPdfModel(input: SupplierStatementPdfInput): StatementPdfModel {
  const { statement } = input;
  const money = (minor: string | number) => formatAmount(minor, statement.currency);
  const closing = Number(statement.closing_balance_minor);
  const notBilled = Number(statement.aging["not_billed_minor"] ?? "0");

  return {
    number: statement.supplier_code,
    title: "SUPPLIER STATEMENT",
    partyHeading: "SUPPLIER",
    columns: ["BILLS", "PAYMENTS"],
    agingHeading: "AMOUNT OWED BY AGE",
    business: partyLines(input.business),
    customer: partyLines(input.supplier),
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
        details: describeSupplierTransaction(t),
        charges: Number(t.credit_minor) > 0 ? money(t.credit_minor) : "",
        payments: Number(t.debit_minor) > 0 ? money(t.debit_minor) : "",
        balance: money(t.balance_minor),
      })),
    ],
    totals: [
      ["Opening balance", money(statement.opening_balance_minor)],
      ["Bills and charges", money(statement.total_credit_minor)],
      ["Payments and credits", money(statement.total_debit_minor)],
    ],
    highlight: closing < 0 ? ["Supplier credit", money(-closing)] : ["Amount owed", money(closing)],
    aging: [
      ...AGING_BUCKETS.map((b): [string, string] => [BUCKET_LABELS[b]!, money(statement.aging[`${b.toLowerCase()}_minor`] ?? "0")]),
      ...(notBilled !== 0 ? [["Not billed", money(notBilled)] as [string, string]] : []),
    ],
    message: null,
    filename: `Statement-${statement.supplier_code}-${statement.period_to}.pdf`,
  };
}
