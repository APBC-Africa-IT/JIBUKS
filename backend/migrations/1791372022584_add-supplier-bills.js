/**
 * Supplier bills (FR-AP-02, FR-AP-03) in the invoices tables, direction 'AP'.
 *
 *   BILL        -- a supplier's invoice to us; posts Dr expense / Dr input VAT
 *                  / Cr payable (supplier). Keeps the supplier's own invoice
 *                  number in supplier_reference.
 *   DEBIT_NOTE  -- reduces a bill (returns, overcharges, a supplier's credit
 *                  note); posts the mirror and is applied to the bill.
 *
 * On 'AP' rows, receivable_account_id holds the PAYABLE account and
 * invoice_lines.income_account_id the expense/asset account; the
 * /supplier-bills API names them accordingly. A sales row always has a
 * customer and no supplier, a bill row the reverse.
 *
 * The same supplier invoice can't be entered twice: supplier +
 * supplier_reference is unique among bills that aren't cancelled.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns("invoices", {
    supplier_id: { type: "uuid", references: "suppliers", onDelete: "RESTRICT" },
    supplier_reference: { type: "text" },
  });
  pgm.alterColumn("invoices", "customer_id", { notNull: false });

  pgm.dropConstraint("invoices", "invoices_direction_check");
  pgm.addConstraint("invoices", "invoices_direction_check", { check: "direction IN ('AR', 'AP')" });
  pgm.dropConstraint("invoices", "invoices_kind_check");
  pgm.addConstraint("invoices", "invoices_kind_check", {
    check: "kind IN ('INVOICE', 'CREDIT_NOTE', 'PROFORMA', 'BILL', 'DEBIT_NOTE')",
  });
  pgm.addConstraint("invoices", "invoices_direction_party_check", {
    check: `(direction = 'AR' AND customer_id IS NOT NULL AND supplier_id IS NULL AND supplier_reference IS NULL
               AND kind IN ('INVOICE', 'CREDIT_NOTE', 'PROFORMA'))
         OR (direction = 'AP' AND supplier_id IS NOT NULL AND customer_id IS NULL
               AND kind IN ('BILL', 'DEBIT_NOTE'))`,
  });
  pgm.dropConstraint("invoices", "invoices_credit_note_link_check");
  pgm.addConstraint("invoices", "invoices_credit_note_link_check", {
    check: "(kind IN ('CREDIT_NOTE', 'DEBIT_NOTE')) = (credited_invoice_id IS NOT NULL)",
  });
  pgm.createIndex("invoices", ["tenant_id", "supplier_id", "supplier_reference"], {
    name: "invoices_supplier_reference_unique",
    unique: true,
    where: "kind = 'BILL' AND supplier_reference IS NOT NULL AND status <> 'CANCELLED'",
  });
  pgm.createIndex("invoices", ["tenant_id", "supplier_id"], { where: "supplier_id IS NOT NULL" });

  pgm.dropConstraint("invoice_allocations", "invoice_allocations_method_check");
  pgm.addConstraint("invoice_allocations", "invoice_allocations_method_check", {
    check: "method IN ('CASH', 'BANK', 'MPESA', 'OTHER', 'CREDIT_NOTE', 'DEBIT_NOTE')",
  });
  pgm.dropConstraint("invoice_allocations", "invoice_allocations_credit_note_check");
  pgm.addConstraint("invoice_allocations", "invoice_allocations_credit_note_check", {
    check: "(method IN ('CREDIT_NOTE', 'DEBIT_NOTE')) = (credit_note_id IS NOT NULL)",
  });

  pgm.dropConstraint("invoice_number_sequences", "invoice_number_sequences_kind_check");
  pgm.addConstraint("invoice_number_sequences", "invoice_number_sequences_kind_check", {
    check: "kind IN ('INVOICE', 'CREDIT_NOTE', 'PROFORMA', 'BILL', 'DEBIT_NOTE')",
  });
};

exports.down = (pgm) => {
  pgm.sql("DELETE FROM invoice_number_sequences WHERE kind IN ('BILL', 'DEBIT_NOTE')");
  pgm.sql("DELETE FROM invoice_allocations WHERE invoice_id IN (SELECT id FROM invoices WHERE direction = 'AP')");
  pgm.sql("DELETE FROM invoices WHERE direction = 'AP'");

  pgm.dropConstraint("invoice_number_sequences", "invoice_number_sequences_kind_check");
  pgm.addConstraint("invoice_number_sequences", "invoice_number_sequences_kind_check", {
    check: "kind IN ('INVOICE', 'CREDIT_NOTE', 'PROFORMA')",
  });
  pgm.dropConstraint("invoice_allocations", "invoice_allocations_credit_note_check");
  pgm.addConstraint("invoice_allocations", "invoice_allocations_credit_note_check", {
    check: "(method = 'CREDIT_NOTE') = (credit_note_id IS NOT NULL)",
  });
  pgm.dropConstraint("invoice_allocations", "invoice_allocations_method_check");
  pgm.addConstraint("invoice_allocations", "invoice_allocations_method_check", {
    check: "method IN ('CASH', 'BANK', 'MPESA', 'OTHER', 'CREDIT_NOTE')",
  });

  pgm.dropIndex("invoices", ["tenant_id", "supplier_id"]);
  pgm.dropIndex("invoices", ["tenant_id", "supplier_id", "supplier_reference"], { name: "invoices_supplier_reference_unique" });
  pgm.dropConstraint("invoices", "invoices_credit_note_link_check");
  pgm.addConstraint("invoices", "invoices_credit_note_link_check", {
    check: "(kind = 'CREDIT_NOTE') = (credited_invoice_id IS NOT NULL)",
  });
  pgm.dropConstraint("invoices", "invoices_direction_party_check");
  pgm.dropConstraint("invoices", "invoices_kind_check");
  pgm.addConstraint("invoices", "invoices_kind_check", { check: "kind IN ('INVOICE', 'CREDIT_NOTE', 'PROFORMA')" });
  pgm.dropConstraint("invoices", "invoices_direction_check");
  pgm.addConstraint("invoices", "invoices_direction_check", { check: "direction IN ('AR')" });
  pgm.alterColumn("invoices", "customer_id", { notNull: true });
  pgm.dropColumns("invoices", ["supplier_id", "supplier_reference"]);
};
