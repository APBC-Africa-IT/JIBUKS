/**
 * Cash purchases as documents: kind CASH_PURCHASE in the invoices tables
 * (POST /cash-purchases), the Suppliers hub's Cash Purchase screen -- goods
 * or services paid for on the spot. The supplier side of a cash sale.
 *
 * Settled when written: created PAID, numbered PUR-000001 (gapless) and
 * posted in one transaction. Direction 'AP'. The supplier is optional
 * (NULL = a one-off seller). With a supplier, the purchase passes through
 * payables so it shows in their history while their balance nets to zero:
 *   Dr line account(s) (net)  Dr input VAT
 *     Cr Accounts Payable, tagged with the supplier (total)
 *   Dr Accounts Payable, tagged with the supplier (total)
 *     Cr the money account (total)
 * Without one, only Dr lines + VAT / Cr money. receivable_account_id holds
 * that payable account and is set exactly when there is a supplier.
 *
 * payment_method (CASH / BANK / MPESA / CHEQUE / OTHER) and
 * deposit_account_id ("the money account": where it was paid from) are
 * required, as on a cash sale; CHEQUE is allowed for cash purchases only.
 * supplier_reference is the seller's receipt or invoice number (not unique:
 * the uniqueness rule covers bills only).
 */

exports.shorthands = undefined;

const KINDS_BEFORE = "'INVOICE', 'CREDIT_NOTE', 'PROFORMA', 'BILL', 'DEBIT_NOTE', 'CASH_SALE', 'CHEQUE'";
const KINDS_AFTER = `${KINDS_BEFORE}, 'CASH_PURCHASE'`;

const PARTY_CHECK_BEFORE = `(direction = 'AR' AND customer_id IS NOT NULL AND supplier_id IS NULL AND supplier_reference IS NULL
               AND kind IN ('INVOICE', 'CREDIT_NOTE', 'PROFORMA'))
         OR (direction = 'AR' AND supplier_id IS NULL AND supplier_reference IS NULL AND kind = 'CASH_SALE')
         OR (direction = 'AP' AND supplier_id IS NOT NULL AND customer_id IS NULL
               AND kind IN ('BILL', 'DEBIT_NOTE'))
         OR (direction = 'AP' AND customer_id IS NULL AND kind = 'CHEQUE')`;

const LEDGER_CHECK_BEFORE =
  "kind = 'PROFORMA' OR status = 'DRAFT'" +
  " OR (kind IN ('CASH_SALE', 'CHEQUE') AND journal_id IS NOT NULL)" +
  " OR (kind NOT IN ('CASH_SALE', 'CHEQUE') AND receivable_account_id IS NOT NULL)";

const SETTLED_CHECK_BEFORE = `(kind IN ('CASH_SALE', 'CHEQUE')) = (deposit_account_id IS NOT NULL)
        AND (kind = 'CASH_SALE') = (payment_method IS NOT NULL)
        AND (kind = 'CHEQUE' OR cheque_number IS NULL)
        AND (kind NOT IN ('CASH_SALE', 'CHEQUE')
             OR (status IN ('PAID', 'CANCELLED') AND receivable_account_id IS NULL AND due_date IS NULL))`;

exports.up = (pgm) => {
  pgm.dropConstraint("invoices", "invoices_kind_check");
  pgm.addConstraint("invoices", "invoices_kind_check", { check: `kind IN (${KINDS_AFTER})` });

  pgm.dropConstraint("invoices", "invoices_direction_party_check");
  pgm.addConstraint("invoices", "invoices_direction_party_check", {
    check: `${PARTY_CHECK_BEFORE}
         OR (direction = 'AP' AND customer_id IS NULL AND kind = 'CASH_PURCHASE')`,
  });

  pgm.dropConstraint("invoices", "invoices_ledger_kind_check");
  pgm.addConstraint("invoices", "invoices_ledger_kind_check", {
    check:
      "kind = 'PROFORMA' OR status = 'DRAFT'" +
      " OR (kind IN ('CASH_SALE', 'CHEQUE', 'CASH_PURCHASE') AND journal_id IS NOT NULL)" +
      " OR (kind NOT IN ('CASH_SALE', 'CHEQUE', 'CASH_PURCHASE') AND receivable_account_id IS NOT NULL)",
  });

  pgm.dropConstraint("invoices", "invoices_settled_check");
  pgm.addConstraint("invoices", "invoices_settled_check", {
    check: `(kind IN ('CASH_SALE', 'CHEQUE', 'CASH_PURCHASE')) = (deposit_account_id IS NOT NULL)
        AND (kind IN ('CASH_SALE', 'CASH_PURCHASE')) = (payment_method IS NOT NULL)
        AND (kind = 'CASH_PURCHASE' OR payment_method IS DISTINCT FROM 'CHEQUE')
        AND (kind = 'CHEQUE' OR cheque_number IS NULL)
        AND (kind NOT IN ('CASH_SALE', 'CHEQUE', 'CASH_PURCHASE') OR (status IN ('PAID', 'CANCELLED') AND due_date IS NULL))
        AND (kind NOT IN ('CASH_SALE', 'CHEQUE') OR receivable_account_id IS NULL)
        AND (kind <> 'CASH_PURCHASE' OR (supplier_id IS NULL) = (receivable_account_id IS NULL))`,
  });

  pgm.dropConstraint("invoices", "invoices_payment_method_check");
  pgm.addConstraint("invoices", "invoices_payment_method_check", {
    check: "payment_method IN ('CASH', 'BANK', 'MPESA', 'CHEQUE', 'OTHER')",
  });

  pgm.dropConstraint("invoice_number_sequences", "invoice_number_sequences_kind_check");
  pgm.addConstraint("invoice_number_sequences", "invoice_number_sequences_kind_check", { check: `kind IN (${KINDS_AFTER})` });
};

exports.down = (pgm) => {
  // Their journals stay -- posted journals are immutable (FR-ACC-02).
  pgm.sql("DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoices WHERE kind = 'CASH_PURCHASE')");
  pgm.sql("DELETE FROM invoice_number_sequences WHERE kind = 'CASH_PURCHASE'");
  pgm.sql("DELETE FROM invoices WHERE kind = 'CASH_PURCHASE'");

  pgm.dropConstraint("invoice_number_sequences", "invoice_number_sequences_kind_check");
  pgm.addConstraint("invoice_number_sequences", "invoice_number_sequences_kind_check", { check: `kind IN (${KINDS_BEFORE})` });
  pgm.dropConstraint("invoices", "invoices_payment_method_check");
  pgm.addConstraint("invoices", "invoices_payment_method_check", {
    check: "payment_method IN ('CASH', 'BANK', 'MPESA', 'OTHER')",
  });
  pgm.dropConstraint("invoices", "invoices_settled_check");
  pgm.addConstraint("invoices", "invoices_settled_check", { check: SETTLED_CHECK_BEFORE });
  pgm.dropConstraint("invoices", "invoices_ledger_kind_check");
  pgm.addConstraint("invoices", "invoices_ledger_kind_check", { check: LEDGER_CHECK_BEFORE });
  pgm.dropConstraint("invoices", "invoices_direction_party_check");
  pgm.addConstraint("invoices", "invoices_direction_party_check", { check: PARTY_CHECK_BEFORE });
  pgm.dropConstraint("invoices", "invoices_kind_check");
  pgm.addConstraint("invoices", "invoices_kind_check", { check: `kind IN (${KINDS_BEFORE})` });
};
