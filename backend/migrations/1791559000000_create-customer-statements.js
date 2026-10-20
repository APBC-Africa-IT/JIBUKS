/**
 * customer_statements -- the Statements screen's "Issue Statement".
 *
 * A statement is a snapshot: what the customer's ledger (GET
 * /customers/{id}/transactions) and aging said for a period at the moment
 * it was issued. The rows and aging are stored as JSON so the PDF reprints
 * exactly what the customer was given, even if something is later
 * backdated into the period. It posts nothing.
 *
 * ST-000001 numbers are gapless per tenant (statement_number_sequences,
 * owned by the customerStatements module, AD-02). sent_at is set when the
 * user marks it sent -- the app shares the PDF itself (WhatsApp, email);
 * the server doesn't send anything yet.
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
  pgm.createTable("customer_statements", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    tenant_id: { type: "uuid", notNull: true, references: "tenants", onDelete: "CASCADE" },
    client_uuid: { type: "uuid", notNull: true },
    number: { type: "text", notNull: true },
    customer_id: { type: "uuid", notNull: true, references: "customers", onDelete: "RESTRICT" },
    period_from: { type: "date", notNull: true },
    period_to: { type: "date", notNull: true },
    /** The customer's currency at issue; null = the tenant's base currency. */
    currency: { type: "text" },
    opening_balance_minor: { type: "bigint", notNull: true },
    total_debit_minor: { type: "bigint", notNull: true },
    total_credit_minor: { type: "bigint", notNull: true },
    closing_balance_minor: { type: "bigint", notNull: true },
    /** The ledger rows for the period, as GET /customers/{id}/transactions returned them. */
    transactions: { type: "jsonb", notNull: true },
    /** Open invoices by age at period_to: { current_minor, days_1_30_minor, ..., not_invoiced_minor }. */
    aging: { type: "jsonb", notNull: true },
    /** Printed on the statement, e.g. "Kindly settle by the 5th". */
    message: { type: "text" },
    created_by: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    sent_at: { type: "timestamptz" },
    sent_by: { type: "uuid", references: "users", onDelete: "RESTRICT" },
  });
  pgm.addConstraint("customer_statements", "customer_statements_tenant_client_uuid_unique", {
    unique: ["tenant_id", "client_uuid"],
  });
  pgm.addConstraint("customer_statements", "customer_statements_tenant_number_unique", {
    unique: ["tenant_id", "number"],
  });
  pgm.addConstraint("customer_statements", "customer_statements_period_check", {
    check: "period_from <= period_to",
  });
  pgm.addConstraint("customer_statements", "customer_statements_sent_check", {
    check: "(sent_at IS NULL) = (sent_by IS NULL)",
  });
  pgm.createIndex("customer_statements", ["customer_id", "period_to"]);
  pgm.createIndex("customer_statements", ["tenant_id", "created_at"]);
  enableRls(pgm, "customer_statements");

  pgm.createTable("statement_number_sequences", {
    tenant_id: { type: "uuid", primaryKey: true, references: "tenants", onDelete: "CASCADE" },
    last_value: { type: "integer", notNull: true },
  });
  enableRls(pgm, "statement_number_sequences");
};

exports.down = (pgm) => {
  pgm.dropTable("statement_number_sequences");
  pgm.dropTable("customer_statements");
};
