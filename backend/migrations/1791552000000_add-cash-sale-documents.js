/**
 * Cash sales as documents: kind CASH_SALE in the invoices tables
 * (POST /sales-receipts).
 *
 * A cash sale is paid on the spot, so it is never a draft: it is created
 * already PAID, numbered CS-000001 from invoice_number_sequences and posted
 * (Dr deposit account / Cr income / Cr output VAT) in one transaction.
 * It is direction 'AR' but owes nothing, so it has no receivable account;
 * the money's account is deposit_account_id and how it was paid is
 * payment_method. The customer is optional (NULL = walk-in).
 *
 * Also:
 *   invoices.memo            -- internal note, never printed for the customer
 *                               (notes is what the customer sees)
 *   invoice_lines.item_name  -- what was sold, free text until an item
 *                               catalogue exists; description stays the detail
 *
 * The older POST /cash-sales (journal only, no document) is unchanged.
 */

exports.shorthands = undefined;

const PARTY_CHECK_BEFORE = `(direction = 'AR' AND customer_id IS NOT NULL AND supplier_id IS NULL AND supplier_reference IS NULL
               AND kind IN ('INVOICE', 'CREDIT_NOTE', 'PROFORMA'))
         OR (direction = 'AP' AND supplier_id IS NOT NULL AND customer_id IS NULL
               AND kind IN ('BILL', 'DEBIT_NOTE'))`;

exports.up = (pgm) => {
  pgm.addColumns("invoices", {
    payment_method: { type: "text", check: "payment_method IN ('CASH', 'BANK', 'MPESA', 'OTHER')" },
    deposit_account_id: { type: "uuid", references: "accounts", onDelete: "RESTRICT" },
    memo: { type: "text" },
  });
  pgm.addColumns("invoice_lines", {
    item_name: { type: "text" },
  });

  pgm.dropConstraint("invoices", "invoices_kind_check");
  pgm.addConstraint("invoices", "invoices_kind_check", {
    check: "kind IN ('INVOICE', 'CREDIT_NOTE', 'PROFORMA', 'BILL', 'DEBIT_NOTE', 'CASH_SALE')",
  });
  pgm.dropConstraint("invoices", "invoices_direction_party_check");
  pgm.addConstraint("invoices", "invoices_direction_party_check", {
    check: `(direction = 'AR' AND customer_id IS NOT NULL AND supplier_id IS NULL AND supplier_reference IS NULL
               AND kind IN ('INVOICE', 'CREDIT_NOTE', 'PROFORMA'))
         OR (direction = 'AR' AND supplier_id IS NULL AND supplier_reference IS NULL AND kind = 'CASH_SALE')
         OR (direction = 'AP' AND supplier_id IS NOT NULL AND customer_id IS NULL
               AND kind IN ('BILL', 'DEBIT_NOTE'))`,
  });
  pgm.dropConstraint("invoices", "invoices_ledger_kind_check");
  pgm.addConstraint("invoices", "invoices_ledger_kind_check", {
    check:
      "kind = 'PROFORMA' OR status = 'DRAFT'" +
      " OR (kind = 'CASH_SALE' AND journal_id IS NOT NULL)" +
      " OR (kind <> 'CASH_SALE' AND receivable_account_id IS NOT NULL)",
  });
  // A cash sale always says how and where it was paid, is never a draft and
  // owes nothing; nothing else carries those columns.
  pgm.addConstraint("invoices", "invoices_cash_sale_check", {
    check: `(kind = 'CASH_SALE') = (payment_method IS NOT NULL AND deposit_account_id IS NOT NULL)
        AND (kind <> 'CASH_SALE' OR (status IN ('PAID', 'CANCELLED') AND receivable_account_id IS NULL AND due_date IS NULL))`,
  });

  pgm.dropConstraint("invoice_number_sequences", "invoice_number_sequences_kind_check");
  pgm.addConstraint("invoice_number_sequences", "invoice_number_sequences_kind_check", {
    check: "kind IN ('INVOICE', 'CREDIT_NOTE', 'PROFORMA', 'BILL', 'DEBIT_NOTE', 'CASH_SALE')",
  });
};

exports.down = (pgm) => {
  // Their journals stay -- posted journals are immutable (FR-ACC-02).
  pgm.sql("DELETE FROM invoice_number_sequences WHERE kind = 'CASH_SALE'");
  pgm.sql("DELETE FROM invoices WHERE kind = 'CASH_SALE'");

  pgm.dropConstraint("invoice_number_sequences", "invoice_number_sequences_kind_check");
  pgm.addConstraint("invoice_number_sequences", "invoice_number_sequences_kind_check", {
    check: "kind IN ('INVOICE', 'CREDIT_NOTE', 'PROFORMA', 'BILL', 'DEBIT_NOTE')",
  });
  pgm.dropConstraint("invoices", "invoices_cash_sale_check");
  pgm.dropConstraint("invoices", "invoices_ledger_kind_check");
  pgm.addConstraint("invoices", "invoices_ledger_kind_check", {
    check: "kind = 'PROFORMA' OR status = 'DRAFT' OR receivable_account_id IS NOT NULL",
  });
  pgm.dropConstraint("invoices", "invoices_direction_party_check");
  pgm.addConstraint("invoices", "invoices_direction_party_check", { check: PARTY_CHECK_BEFORE });
  pgm.dropConstraint("invoices", "invoices_kind_check");
  pgm.addConstraint("invoices", "invoices_kind_check", {
    check: "kind IN ('INVOICE', 'CREDIT_NOTE', 'PROFORMA', 'BILL', 'DEBIT_NOTE')",
  });

  pgm.dropColumns("invoice_lines", ["item_name"]);
  pgm.dropColumns("invoices", ["payment_method", "deposit_account_id", "memo"]);
};
