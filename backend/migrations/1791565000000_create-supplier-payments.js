/**
 * supplier_payments -- money paid to a supplier (the Pay Bills screen),
 * numbered SP-000001 gapless per tenant. The supplier side of
 * customer_payments.
 *
 * One payment posts one journal (Dr payables tagged with the supplier,
 * Cr the money account) and is applied to any number of the supplier's
 * bills through invoice_allocations rows that point back at it
 * (supplier_payment_id) and share its journal. What isn't applied stays on
 * the payment as unapplied_minor: supplier credit (an advance), already in
 * their ledger balance, to be applied to a later bill or refunded by the
 * supplier. refunded_minor and credit_account_id (the payable account the
 * credit was posted to) are kept for that, as on customer payments:
 * amount = applied + unapplied + refunded.
 *
 * CHEQUE becomes a payment method on the supplier side (bill allocations
 * and supplier payments); customer payments keep their four.
 *
 * Every AP payment goes through here from now on: POST /supplier-payments
 * and POST /supplier-bills/{id}/payments. Existing bill payment
 * allocations are backfilled, one payment per journal, numbered in the
 * order they were recorded. Their journals are untouched.
 *
 * Owned by the supplierPayments module (AD-02);
 * supplier_payment_number_sequences holds the counter.
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
  pgm.createTable("supplier_payments", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    tenant_id: { type: "uuid", notNull: true, references: "tenants", onDelete: "CASCADE" },
    client_uuid: { type: "uuid", notNull: true },
    number: { type: "text", notNull: true },
    supplier_id: { type: "uuid", notNull: true, references: "suppliers", onDelete: "RESTRICT" },
    date: { type: "date", notNull: true },
    currency: { type: "text", notNull: true },
    amount_minor: { type: "bigint", notNull: true },
    applied_minor: { type: "bigint", notNull: true },
    unapplied_minor: { type: "bigint", notNull: true },
    refunded_minor: { type: "bigint", notNull: true, default: 0 },
    credit_account_id: { type: "uuid", references: "accounts", onDelete: "RESTRICT" },
    method: { type: "text", notNull: true, check: "method IN ('CASH', 'BANK', 'MPESA', 'CHEQUE', 'OTHER')" },
    paid_from_account_id: { type: "uuid", notNull: true, references: "accounts", onDelete: "RESTRICT" },
    reference: { type: "text" },
    memo: { type: "text" },
    journal_id: { type: "uuid", notNull: true, references: "journals", onDelete: "RESTRICT" },
    created_by: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("supplier_payments", "supplier_payments_tenant_client_uuid_unique", { unique: ["tenant_id", "client_uuid"] });
  pgm.addConstraint("supplier_payments", "supplier_payments_tenant_number_unique", { unique: ["tenant_id", "number"] });
  pgm.addConstraint("supplier_payments", "supplier_payments_amounts_check", {
    check:
      "amount_minor > 0 AND applied_minor >= 0 AND unapplied_minor >= 0 AND refunded_minor >= 0 " +
      "AND amount_minor = applied_minor + unapplied_minor + refunded_minor",
  });
  pgm.createIndex("supplier_payments", ["journal_id"], { name: "supplier_payments_journal_unique", unique: true });
  pgm.createIndex("supplier_payments", ["supplier_id", "date"]);
  pgm.createIndex("supplier_payments", ["tenant_id", "created_at"]);
  enableRls(pgm, "supplier_payments");

  pgm.createTable("supplier_payment_number_sequences", {
    tenant_id: { type: "uuid", primaryKey: true, references: "tenants", onDelete: "CASCADE" },
    last_value: { type: "integer", notNull: true },
  });
  enableRls(pgm, "supplier_payment_number_sequences");

  pgm.addColumns("invoice_allocations", {
    supplier_payment_id: { type: "uuid", references: "supplier_payments", onDelete: "RESTRICT" },
  });
  pgm.createIndex("invoice_allocations", ["supplier_payment_id"]);
  pgm.dropConstraint("invoice_allocations", "invoice_allocations_method_check");
  pgm.addConstraint("invoice_allocations", "invoice_allocations_method_check", {
    check: "method IN ('CASH', 'BANK', 'MPESA', 'CHEQUE', 'OTHER', 'CREDIT_NOTE', 'DEBIT_NOTE')",
  });

  // Backfill: one payment per journal that paid AP bills -- before this
  // migration that is one allocation each, never with anything unapplied.
  // Runs as the migration owner, which RLS doesn't restrict.
  pgm.sql(`
    WITH source AS (
      SELECT a.*, i.supplier_id, i.currency
        FROM invoice_allocations a
        JOIN invoices i ON i.id = a.invoice_id
       WHERE i.direction = 'AP' AND a.method IN ('CASH', 'BANK', 'MPESA', 'OTHER')
    ),
    by_journal AS (
      SELECT DISTINCT ON (journal_id)
             journal_id, tenant_id, client_uuid, supplier_id, currency, date, method, received_account_id,
             reference, created_by, created_at,
             SUM(amount_minor) OVER (PARTITION BY journal_id) AS applied_minor,
             SUM(unapplied_minor) OVER (PARTITION BY journal_id) AS unapplied_minor
        FROM source
       ORDER BY journal_id, created_at, id
    ),
    numbered AS (
      SELECT b.*, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, journal_id) AS seq
        FROM by_journal b
    ),
    inserted AS (
      INSERT INTO supplier_payments
        (id, tenant_id, client_uuid, number, supplier_id, date, currency, amount_minor, applied_minor,
         unapplied_minor, method, paid_from_account_id, reference, journal_id, created_by, created_at)
      SELECT gen_random_uuid(), n.tenant_id, n.client_uuid, 'SP-' || lpad(n.seq::text, 6, '0'), n.supplier_id, n.date,
             n.currency, n.applied_minor + n.unapplied_minor, n.applied_minor, n.unapplied_minor, n.method,
             n.received_account_id, n.reference, n.journal_id, n.created_by, n.created_at
        FROM numbered n
      RETURNING id, journal_id
    )
    UPDATE invoice_allocations a SET supplier_payment_id = inserted.id
      FROM inserted
     WHERE a.journal_id = inserted.journal_id AND a.credit_note_id IS NULL
  `);
  pgm.sql(`
    INSERT INTO supplier_payment_number_sequences (tenant_id, last_value)
    SELECT tenant_id, count(*) FROM supplier_payments GROUP BY tenant_id
  `);
};

/**
 * Lossy: payments applied to nothing (all credit) and the credit on
 * payments made since are forgotten; refuses while CHEQUE allocations
 * exist. Journals stay, so ledger balances are unaffected.
 */
exports.down = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM invoice_allocations WHERE method = 'CHEQUE') THEN
        RAISE EXCEPTION 'Bill payments by CHEQUE exist; change them to BANK before migrating down';
      END IF;
    END $$
  `);
  pgm.dropConstraint("invoice_allocations", "invoice_allocations_method_check");
  pgm.addConstraint("invoice_allocations", "invoice_allocations_method_check", {
    check: "method IN ('CASH', 'BANK', 'MPESA', 'OTHER', 'CREDIT_NOTE', 'DEBIT_NOTE')",
  });
  pgm.dropIndex("invoice_allocations", ["supplier_payment_id"]);
  pgm.dropColumns("invoice_allocations", ["supplier_payment_id"]);
  pgm.dropTable("supplier_payment_number_sequences");
  pgm.dropTable("supplier_payments");
};
