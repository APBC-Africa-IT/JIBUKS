/**
 * Supplier credit: debit notes without a bill, applying credit to bills
 * later, and refunds received from suppliers. The supplier side of
 * 1791561000000_add-customer-credit.
 *
 * A supplier's credit is held in two places:
 *   - debit notes: total_minor - amount_paid_minor, where amount_paid_minor
 *     now counts what the note has been USED for (applied to bills or
 *     refunded by the supplier). A note raised against a bill is used in
 *     full when posted; one raised against no bill (debited bill NULL --
 *     already allowed by invoices_credit_note_link_check) starts unused.
 *   - supplier payments: unapplied_minor (an advance). A refund draws it
 *     down into refunded_minor; credit_account_id is the payable account it
 *     sits in. Both columns came with 1791565000000.
 *
 * Applying credit adds invoice_allocations rows that point at the debit
 * note (credit_note_id) or payment (supplier_payment_id) and share its
 * journal -- nothing new is posted, the credit is already in payables.
 *
 * supplier_refunds (SRF-000001, gapless) post Dr the money account /
 * Cr payables (tagged with the supplier); supplier_refund_sources says
 * which credit each drew on. Owned by the supplierCredits module (AD-02).
 */

exports.shorthands = undefined;

function enableRls(pgm, table) {
  pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  pgm.sql(`
    CREATE POLICY tenant_isolation ON ${table}
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  `);
}

exports.up = (pgm) => {
  // Debit notes posted so far: used = what was applied to their bill.
  pgm.sql(`
    UPDATE invoices n SET amount_paid_minor = used.amount
      FROM (SELECT credit_note_id, SUM(amount_minor) AS amount
              FROM invoice_allocations WHERE credit_note_id IS NOT NULL GROUP BY credit_note_id) used
     WHERE n.id = used.credit_note_id AND n.kind = 'DEBIT_NOTE'
  `);

  // Payments with credit and no account recorded: it went to the supplier-tagged payable line.
  pgm.sql(`
    UPDATE supplier_payments p SET credit_account_id = (
      SELECT jl.account_id FROM journal_lines jl
       WHERE jl.journal_id = p.journal_id AND jl.supplier_id IS NOT NULL AND jl.debit_minor > 0
       ORDER BY jl.debit_minor DESC LIMIT 1)
     WHERE p.unapplied_minor > 0 AND p.credit_account_id IS NULL
  `);

  pgm.createTable("supplier_refunds", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    tenant_id: { type: "uuid", notNull: true, references: "tenants", onDelete: "CASCADE" },
    client_uuid: { type: "uuid", notNull: true },
    number: { type: "text", notNull: true },
    supplier_id: { type: "uuid", notNull: true, references: "suppliers", onDelete: "RESTRICT" },
    date: { type: "date", notNull: true },
    currency: { type: "text", notNull: true },
    amount_minor: { type: "bigint", notNull: true, check: "amount_minor > 0" },
    method: { type: "text", notNull: true, check: "method IN ('CASH', 'BANK', 'MPESA', 'CHEQUE', 'OTHER')" },
    received_account_id: { type: "uuid", notNull: true, references: "accounts", onDelete: "RESTRICT" },
    reference: { type: "text" },
    memo: { type: "text" },
    journal_id: { type: "uuid", notNull: true, references: "journals", onDelete: "RESTRICT" },
    created_by: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("supplier_refunds", "supplier_refunds_tenant_client_uuid_unique", { unique: ["tenant_id", "client_uuid"] });
  pgm.addConstraint("supplier_refunds", "supplier_refunds_tenant_number_unique", { unique: ["tenant_id", "number"] });
  pgm.createIndex("supplier_refunds", ["journal_id"], { name: "supplier_refunds_journal_unique", unique: true });
  pgm.createIndex("supplier_refunds", ["supplier_id", "date"]);
  pgm.createIndex("supplier_refunds", ["tenant_id", "created_at"]);
  enableRls(pgm, "supplier_refunds");

  pgm.createTable("supplier_refund_sources", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    tenant_id: { type: "uuid", notNull: true, references: "tenants", onDelete: "CASCADE" },
    refund_id: { type: "uuid", notNull: true, references: "supplier_refunds", onDelete: "CASCADE" },
    debit_note_id: { type: "uuid", references: "invoices", onDelete: "RESTRICT" },
    supplier_payment_id: { type: "uuid", references: "supplier_payments", onDelete: "RESTRICT" },
    amount_minor: { type: "bigint", notNull: true, check: "amount_minor > 0" },
  });
  pgm.addConstraint("supplier_refund_sources", "supplier_refund_sources_one_source_check", {
    check: "(debit_note_id IS NULL) <> (supplier_payment_id IS NULL)",
  });
  pgm.createIndex("supplier_refund_sources", ["refund_id"]);
  enableRls(pgm, "supplier_refund_sources");

  pgm.createTable("supplier_refund_number_sequences", {
    tenant_id: { type: "uuid", primaryKey: true, references: "tenants", onDelete: "CASCADE" },
    last_value: { type: "integer", notNull: true },
  });
  enableRls(pgm, "supplier_refund_number_sequences");
};

/**
 * Lossy: refunds' records go (their journals stay), refunded amounts count
 * as applied, and debit notes forget what of them was used.
 */
exports.down = (pgm) => {
  pgm.dropTable("supplier_refund_number_sequences");
  pgm.dropTable("supplier_refund_sources");
  pgm.dropTable("supplier_refunds");
  pgm.sql("UPDATE supplier_payments SET applied_minor = applied_minor + refunded_minor, refunded_minor = 0");
  pgm.sql("UPDATE invoices SET amount_paid_minor = 0 WHERE kind = 'DEBIT_NOTE'");
};
