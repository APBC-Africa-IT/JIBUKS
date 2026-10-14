/**
 * Cheques as documents: kind CHEQUE in the invoices tables
 * (POST /cheque-payments), the Write Cheque screen.
 *
 * Like a cash sale it is settled the moment it is written: created PAID,
 * numbered CHQ-000001 (gapless) and posted in one transaction --
 *   Dr expense / stock / other account(s) (net)
 *   Dr input VAT
 *     Cr the bank account (total)
 * It is direction 'AP'. The payee (supplier_id) is optional and recorded on
 * the cheque only -- nothing is owed, so it isn't tagged in the ledger.
 *
 * deposit_account_id is now "the money account" of a settled document:
 * where a cash sale's money went, or the bank a cheque is drawn on.
 * payment_method stays cash-sale only. cheque_number is the number printed
 * on the cheque book leaf; it can't repeat on the same bank account unless
 * the earlier cheque was cancelled.
 */

exports.shorthands = undefined;

const PARTY_CHECK_BEFORE = `(direction = 'AR' AND customer_id IS NOT NULL AND supplier_id IS NULL AND supplier_reference IS NULL
               AND kind IN ('INVOICE', 'CREDIT_NOTE', 'PROFORMA'))
         OR (direction = 'AR' AND supplier_id IS NULL AND supplier_reference IS NULL AND kind = 'CASH_SALE')
         OR (direction = 'AP' AND supplier_id IS NOT NULL AND customer_id IS NULL
               AND kind IN ('BILL', 'DEBIT_NOTE'))`;

const CASH_SALE_CHECK_BEFORE = `(kind = 'CASH_SALE') = (payment_method IS NOT NULL AND deposit_account_id IS NOT NULL)
        AND (kind <> 'CASH_SALE' OR (status IN ('PAID', 'CANCELLED') AND receivable_account_id IS NULL AND due_date IS NULL))`;

exports.up = (pgm) => {
  pgm.addColumns("invoices", {
    cheque_number: { type: "text" },
  });

  pgm.dropConstraint("invoices", "invoices_kind_check");
  pgm.addConstraint("invoices", "invoices_kind_check", {
    check: "kind IN ('INVOICE', 'CREDIT_NOTE', 'PROFORMA', 'BILL', 'DEBIT_NOTE', 'CASH_SALE', 'CHEQUE')",
  });
  pgm.dropConstraint("invoices", "invoices_direction_party_check");
  pgm.addConstraint("invoices", "invoices_direction_party_check", {
    check: `${PARTY_CHECK_BEFORE}
         OR (direction = 'AP' AND customer_id IS NULL AND kind = 'CHEQUE')`,
  });
  pgm.dropConstraint("invoices", "invoices_ledger_kind_check");
  pgm.addConstraint("invoices", "invoices_ledger_kind_check", {
    check:
      "kind = 'PROFORMA' OR status = 'DRAFT'" +
      " OR (kind IN ('CASH_SALE', 'CHEQUE') AND journal_id IS NOT NULL)" +
      " OR (kind NOT IN ('CASH_SALE', 'CHEQUE') AND receivable_account_id IS NOT NULL)",
  });
  pgm.dropConstraint("invoices", "invoices_cash_sale_check");
  pgm.addConstraint("invoices", "invoices_settled_check", {
    check: `(kind IN ('CASH_SALE', 'CHEQUE')) = (deposit_account_id IS NOT NULL)
        AND (kind = 'CASH_SALE') = (payment_method IS NOT NULL)
        AND (kind = 'CHEQUE' OR cheque_number IS NULL)
        AND (kind NOT IN ('CASH_SALE', 'CHEQUE')
             OR (status IN ('PAID', 'CANCELLED') AND receivable_account_id IS NULL AND due_date IS NULL))`,
  });
  pgm.createIndex("invoices", ["tenant_id", "deposit_account_id", "cheque_number"], {
    name: "invoices_cheque_number_unique",
    unique: true,
    where: "kind = 'CHEQUE' AND cheque_number IS NOT NULL AND status <> 'CANCELLED'",
  });

  pgm.dropConstraint("invoice_number_sequences", "invoice_number_sequences_kind_check");
  pgm.addConstraint("invoice_number_sequences", "invoice_number_sequences_kind_check", {
    check: "kind IN ('INVOICE', 'CREDIT_NOTE', 'PROFORMA', 'BILL', 'DEBIT_NOTE', 'CASH_SALE', 'CHEQUE')",
  });
};

exports.down = (pgm) => {
  // Their journals stay -- posted journals are immutable (FR-ACC-02).
  pgm.sql("DELETE FROM invoice_number_sequences WHERE kind = 'CHEQUE'");
  pgm.sql("DELETE FROM invoices WHERE kind = 'CHEQUE'");

  pgm.dropConstraint("invoice_number_sequences", "invoice_number_sequences_kind_check");
  pgm.addConstraint("invoice_number_sequences", "invoice_number_sequences_kind_check", {
    check: "kind IN ('INVOICE', 'CREDIT_NOTE', 'PROFORMA', 'BILL', 'DEBIT_NOTE', 'CASH_SALE')",
  });
  pgm.dropIndex("invoices", ["tenant_id", "deposit_account_id", "cheque_number"], { name: "invoices_cheque_number_unique" });
  pgm.dropConstraint("invoices", "invoices_settled_check");
  pgm.addConstraint("invoices", "invoices_cash_sale_check", { check: CASH_SALE_CHECK_BEFORE });
  pgm.dropConstraint("invoices", "invoices_ledger_kind_check");
  pgm.addConstraint("invoices", "invoices_ledger_kind_check", {
    check:
      "kind = 'PROFORMA' OR status = 'DRAFT'" +
      " OR (kind = 'CASH_SALE' AND journal_id IS NOT NULL)" +
      " OR (kind <> 'CASH_SALE' AND receivable_account_id IS NOT NULL)",
  });
  pgm.dropConstraint("invoices", "invoices_direction_party_check");
  pgm.addConstraint("invoices", "invoices_direction_party_check", { check: PARTY_CHECK_BEFORE });
  pgm.dropConstraint("invoices", "invoices_kind_check");
  pgm.addConstraint("invoices", "invoices_kind_check", {
    check: "kind IN ('INVOICE', 'CREDIT_NOTE', 'PROFORMA', 'BILL', 'DEBIT_NOTE', 'CASH_SALE')",
  });
  pgm.dropColumns("invoices", ["cheque_number"]);
};
