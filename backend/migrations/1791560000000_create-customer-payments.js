/**
 * customer_payments -- money received from a customer (the Receive
 * Payments screen), numbered PMT-000001 gapless per tenant.
 *
 * One payment posts one journal (Dr the money account, Cr receivables
 * tagged with the customer) and is applied to any number of the customer's
 * invoices through invoice_allocations rows that point back at it
 * (customer_payment_id) and share its journal. What isn't applied stays on
 * the payment as unapplied_minor: customer credit, already in their
 * ledger balance, to be applied to a later invoice or refunded.
 *
 * Every AR payment goes through here from now on: POST /customer-payments,
 * POST /invoices/{id}/payments and M-Pesa collections against an invoice.
 * Existing payment allocations are backfilled, one payment per journal,
 * numbered in the order they were recorded. Their journals are untouched.
 *
 * Owned by the customerPayments module (AD-02); payment_number_sequences
 * holds the counter.
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
  pgm.createTable("customer_payments", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    tenant_id: { type: "uuid", notNull: true, references: "tenants", onDelete: "CASCADE" },
    client_uuid: { type: "uuid", notNull: true },
    number: { type: "text", notNull: true },
    customer_id: { type: "uuid", notNull: true, references: "customers", onDelete: "RESTRICT" },
    date: { type: "date", notNull: true },
    currency: { type: "text", notNull: true },
    amount_minor: { type: "bigint", notNull: true },
    applied_minor: { type: "bigint", notNull: true },
    unapplied_minor: { type: "bigint", notNull: true },
    method: { type: "text", notNull: true, check: "method IN ('CASH', 'BANK', 'MPESA', 'OTHER')" },
    received_account_id: { type: "uuid", references: "accounts", onDelete: "RESTRICT" },
    reference: { type: "text" },
    memo: { type: "text" },
    journal_id: { type: "uuid", notNull: true, references: "journals", onDelete: "RESTRICT" },
    /** Set for an M-Pesa collection (payments table). */
    payment_id: { type: "uuid", references: "payments", onDelete: "RESTRICT" },
    created_by: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("customer_payments", "customer_payments_tenant_client_uuid_unique", { unique: ["tenant_id", "client_uuid"] });
  pgm.addConstraint("customer_payments", "customer_payments_tenant_number_unique", { unique: ["tenant_id", "number"] });
  pgm.addConstraint("customer_payments", "customer_payments_amounts_check", {
    check: "amount_minor > 0 AND applied_minor >= 0 AND unapplied_minor >= 0 AND amount_minor = applied_minor + unapplied_minor",
  });
  pgm.createIndex("customer_payments", ["journal_id"], { name: "customer_payments_journal_unique", unique: true });
  pgm.createIndex("customer_payments", ["payment_id"], {
    name: "customer_payments_payment_unique",
    unique: true,
    where: "payment_id IS NOT NULL",
  });
  pgm.createIndex("customer_payments", ["customer_id", "date"]);
  pgm.createIndex("customer_payments", ["tenant_id", "created_at"]);
  enableRls(pgm, "customer_payments");

  pgm.createTable("payment_number_sequences", {
    tenant_id: { type: "uuid", primaryKey: true, references: "tenants", onDelete: "CASCADE" },
    last_value: { type: "integer", notNull: true },
  });
  enableRls(pgm, "payment_number_sequences");

  pgm.addColumns("invoice_allocations", {
    customer_payment_id: { type: "uuid", references: "customer_payments", onDelete: "RESTRICT" },
  });
  pgm.createIndex("invoice_allocations", ["customer_payment_id"]);

  // Backfill: one payment per journal that paid AR invoices -- before this
  // migration that is one allocation each. Runs as the migration owner,
  // which RLS doesn't restrict.
  pgm.sql(`
    WITH source AS (
      SELECT a.*, i.customer_id, i.currency
        FROM invoice_allocations a
        JOIN invoices i ON i.id = a.invoice_id
       WHERE i.direction = 'AR' AND a.method IN ('CASH', 'BANK', 'MPESA', 'OTHER')
    ),
    by_journal AS (
      SELECT DISTINCT ON (journal_id)
             journal_id, tenant_id, client_uuid, customer_id, currency, date, method, received_account_id,
             reference, payment_id, created_by, created_at,
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
      INSERT INTO customer_payments
        (id, tenant_id, client_uuid, number, customer_id, date, currency, amount_minor, applied_minor,
         unapplied_minor, method, received_account_id, reference, journal_id, payment_id, created_by, created_at)
      SELECT gen_random_uuid(), n.tenant_id, n.client_uuid, 'PMT-' || lpad(n.seq::text, 6, '0'), n.customer_id, n.date,
             n.currency, n.applied_minor + n.unapplied_minor, n.applied_minor, n.unapplied_minor, n.method,
             n.received_account_id, n.reference, n.journal_id, n.payment_id, n.created_by, n.created_at
        FROM numbered n
      RETURNING id, journal_id
    )
    UPDATE invoice_allocations a SET customer_payment_id = inserted.id
      FROM inserted
     WHERE a.journal_id = inserted.journal_id AND a.credit_note_id IS NULL
  `);
  pgm.sql(`
    INSERT INTO payment_number_sequences (tenant_id, last_value)
    SELECT tenant_id, count(*) FROM customer_payments GROUP BY tenant_id
  `);
};

/**
 * Lossy: payments applied to nothing (all credit) and the credit kept on
 * payments made since are forgotten. Their journals stay, so ledger
 * balances are unaffected.
 */
exports.down = (pgm) => {
  pgm.dropIndex("invoice_allocations", ["customer_payment_id"]);
  pgm.dropColumns("invoice_allocations", ["customer_payment_id"]);
  pgm.dropTable("payment_number_sequences");
  pgm.dropTable("customer_payments");
};
