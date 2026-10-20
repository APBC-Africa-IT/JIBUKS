/**
 * Customer credit: credit notes without an invoice, applying credit to
 * invoices later, and refunds (the Credit Note screen).
 *
 * A customer's credit is held in two places:
 *   - credit notes: total_minor - amount_paid_minor, where amount_paid_minor
 *     now counts what the note has been USED for (applied to invoices or
 *     refunded). A note raised against an invoice is used in full when
 *     issued, as before; one raised against no invoice
 *     (credited_invoice_id NULL) starts with all of it unused.
 *   - customer payments: unapplied_minor. A refund draws it down into the
 *     new refunded_minor, so amount = applied + unapplied + refunded.
 * credit_account_id records which receivable account a payment's credit
 * was posted to, so applying or refunding it uses the same account.
 *
 * Applying credit adds invoice_allocations rows that point at the credit
 * note (credit_note_id) or payment (customer_payment_id) and share its
 * journal -- nothing new is posted, the credit is already in receivables.
 * A credit note can now be applied to several invoices, so its allocation
 * is no longer unique.
 *
 * customer_refunds (RF-000001, gapless) post Dr receivables / Cr the money
 * account; customer_refund_sources says which credit each drew on.
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
  // Credit notes and debit notes may stand alone; nothing else may credit an invoice.
  pgm.dropConstraint("invoices", "invoices_credit_note_link_check");
  pgm.addConstraint("invoices", "invoices_credit_note_link_check", {
    check: "credited_invoice_id IS NULL OR kind IN ('CREDIT_NOTE', 'DEBIT_NOTE')",
  });

  pgm.dropIndex("invoice_allocations", ["credit_note_id"], { name: "invoice_allocations_credit_note_unique" });
  pgm.createIndex("invoice_allocations", ["credit_note_id"]);

  // Credit notes issued so far: used = what was applied to their invoice.
  pgm.sql(`
    UPDATE invoices n SET amount_paid_minor = used.amount
      FROM (SELECT credit_note_id, SUM(amount_minor) AS amount
              FROM invoice_allocations WHERE credit_note_id IS NOT NULL GROUP BY credit_note_id) used
     WHERE n.id = used.credit_note_id AND n.kind = 'CREDIT_NOTE'
  `);

  pgm.addColumns("customer_payments", {
    refunded_minor: { type: "bigint", notNull: true, default: 0 },
    credit_account_id: { type: "uuid", references: "accounts", onDelete: "RESTRICT" },
  });
  pgm.dropConstraint("customer_payments", "customer_payments_amounts_check");
  pgm.addConstraint("customer_payments", "customer_payments_amounts_check", {
    check:
      "amount_minor > 0 AND applied_minor >= 0 AND unapplied_minor >= 0 AND refunded_minor >= 0" +
      " AND amount_minor = applied_minor + unapplied_minor + refunded_minor",
  });
  // Payments with credit so far: it went to the receivable line of their journal.
  pgm.sql(`
    UPDATE customer_payments p SET credit_account_id = (
      SELECT jl.account_id FROM journal_lines jl
       WHERE jl.journal_id = p.journal_id AND jl.customer_id IS NOT NULL AND jl.credit_minor > 0
       ORDER BY jl.credit_minor DESC LIMIT 1)
     WHERE p.unapplied_minor > 0
  `);

  pgm.createTable("customer_refunds", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    tenant_id: { type: "uuid", notNull: true, references: "tenants", onDelete: "CASCADE" },
    client_uuid: { type: "uuid", notNull: true },
    number: { type: "text", notNull: true },
    customer_id: { type: "uuid", notNull: true, references: "customers", onDelete: "RESTRICT" },
    date: { type: "date", notNull: true },
    currency: { type: "text", notNull: true },
    amount_minor: { type: "bigint", notNull: true, check: "amount_minor > 0" },
    method: { type: "text", notNull: true, check: "method IN ('CASH', 'BANK', 'MPESA', 'OTHER')" },
    paid_from_account_id: { type: "uuid", notNull: true, references: "accounts", onDelete: "RESTRICT" },
    reference: { type: "text" },
    memo: { type: "text" },
    journal_id: { type: "uuid", notNull: true, references: "journals", onDelete: "RESTRICT" },
    created_by: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("customer_refunds", "customer_refunds_tenant_client_uuid_unique", { unique: ["tenant_id", "client_uuid"] });
  pgm.addConstraint("customer_refunds", "customer_refunds_tenant_number_unique", { unique: ["tenant_id", "number"] });
  pgm.createIndex("customer_refunds", ["journal_id"], { name: "customer_refunds_journal_unique", unique: true });
  pgm.createIndex("customer_refunds", ["customer_id", "date"]);
  pgm.createIndex("customer_refunds", ["tenant_id", "created_at"]);
  enableRls(pgm, "customer_refunds");

  pgm.createTable("customer_refund_sources", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    tenant_id: { type: "uuid", notNull: true, references: "tenants", onDelete: "CASCADE" },
    refund_id: { type: "uuid", notNull: true, references: "customer_refunds", onDelete: "CASCADE" },
    credit_note_id: { type: "uuid", references: "invoices", onDelete: "RESTRICT" },
    customer_payment_id: { type: "uuid", references: "customer_payments", onDelete: "RESTRICT" },
    amount_minor: { type: "bigint", notNull: true, check: "amount_minor > 0" },
  });
  pgm.addConstraint("customer_refund_sources", "customer_refund_sources_one_source_check", {
    check: "(credit_note_id IS NULL) <> (customer_payment_id IS NULL)",
  });
  pgm.createIndex("customer_refund_sources", ["refund_id"]);
  enableRls(pgm, "customer_refund_sources");

  pgm.createTable("refund_number_sequences", {
    tenant_id: { type: "uuid", primaryKey: true, references: "tenants", onDelete: "CASCADE" },
    last_value: { type: "integer", notNull: true },
  });
  enableRls(pgm, "refund_number_sequences");
};

/**
 * Fails while a credit note without an invoice exists. Lossy: refunds'
 * records go (their journals stay) and refunded amounts count as applied.
 */
exports.down = (pgm) => {
  pgm.dropTable("refund_number_sequences");
  pgm.dropTable("customer_refund_sources");
  pgm.dropTable("customer_refunds");
  pgm.dropConstraint("customer_payments", "customer_payments_amounts_check");
  // Refunded money has left: count it as used, not as credit again.
  pgm.sql("UPDATE customer_payments SET applied_minor = applied_minor + refunded_minor");
  pgm.addConstraint("customer_payments", "customer_payments_amounts_check", {
    check: "amount_minor > 0 AND applied_minor >= 0 AND unapplied_minor >= 0 AND amount_minor = applied_minor + unapplied_minor",
  });
  pgm.dropColumns("customer_payments", ["refunded_minor", "credit_account_id"]);
  pgm.sql("UPDATE invoices SET amount_paid_minor = 0 WHERE kind = 'CREDIT_NOTE'");
  pgm.dropIndex("invoice_allocations", ["credit_note_id"]);
  pgm.createIndex("invoice_allocations", ["credit_note_id"], {
    name: "invoice_allocations_credit_note_unique",
    unique: true,
    where: "credit_note_id IS NOT NULL",
  });
  pgm.dropConstraint("invoices", "invoices_credit_note_link_check");
  pgm.addConstraint("invoices", "invoices_credit_note_link_check", {
    check: "(kind IN ('CREDIT_NOTE', 'DEBIT_NOTE')) = (credited_invoice_id IS NOT NULL)",
  });
};
