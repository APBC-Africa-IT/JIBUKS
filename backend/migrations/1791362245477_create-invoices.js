/**
 * Create invoices (FR-AR-02/05, FR-PAY-04, Section 6.1 invoices /
 * invoice_lines).
 *
 * One table for every invoice-shaped document, told apart by `kind`:
 *   INVOICE      -- a sales invoice; posts Dr AR / Cr income / Cr VAT on issue.
 *   CREDIT_NOTE  -- reduces an issued invoice (credited_invoice_id); posts the
 *                   mirror journal on issue and is applied to that invoice.
 *   PROFORMA     -- a quote; never touches the ledger, may be converted once
 *                   into a draft INVOICE (proforma_id on the new invoice).
 * `direction` is 'AR' only for now -- supplier bills (step C) reuse this table.
 *
 * Stored status: DRAFT -> ISSUED -> PART_PAID -> PAID, or CANCELLED. OVERDUE
 * is derived on read (issued/part-paid and past due_date), never stored, so it
 * can't go stale without a scheduler.
 *
 * Numbers (INV-000001, CN-000001, PF-000001) come from
 * invoice_number_sequences and are assigned in the same transaction that
 * issues the document, so they are gapless; drafts have none.
 *
 * invoice_allocations: one row per amount applied to an invoice -- a manual
 * payment, an M-Pesa payment (payment_id) or a credit note (credit_note_id).
 * amount_paid_minor on the invoice is always their sum. unapplied_minor is
 * money received for the invoice beyond its balance (e.g. an M-Pesa payment
 * landing after the invoice was paid another way): it was posted to the
 * customer's receivable, so it stays as customer credit.
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
  pgm.createTable("invoices", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    tenant_id: { type: "uuid", notNull: true, references: "tenants", onDelete: "CASCADE" },
    client_uuid: { type: "uuid", notNull: true },
    branch_id: { type: "uuid" },
    direction: { type: "text", notNull: true, default: "AR", check: "direction IN ('AR')" },
    kind: { type: "text", notNull: true, check: "kind IN ('INVOICE', 'CREDIT_NOTE', 'PROFORMA')" },
    status: {
      type: "text",
      notNull: true,
      default: "DRAFT",
      check: "status IN ('DRAFT', 'ISSUED', 'PART_PAID', 'PAID', 'CANCELLED')",
    },
    number: { type: "text" },
    customer_id: { type: "uuid", notNull: true, references: "customers", onDelete: "RESTRICT" },
    issue_date: { type: "date", notNull: true },
    due_date: { type: "date" },
    currency: { type: "text", notNull: true },
    receivable_account_id: { type: "uuid", references: "accounts", onDelete: "RESTRICT" },
    tax_mode: { type: "text", notNull: true, check: "tax_mode IN ('EXCLUSIVE', 'INCLUSIVE', 'NONE')" },
    subtotal_minor: { type: "bigint", notNull: true },
    tax_minor: { type: "bigint", notNull: true },
    total_minor: { type: "bigint", notNull: true },
    amount_paid_minor: { type: "bigint", notNull: true, default: 0 },
    reference: { type: "text" },
    notes: { type: "text" },
    journal_id: { type: "uuid", references: "journals", onDelete: "RESTRICT" },
    cancel_journal_id: { type: "uuid", references: "journals", onDelete: "RESTRICT" },
    credited_invoice_id: { type: "uuid", references: "invoices", onDelete: "RESTRICT" },
    proforma_id: { type: "uuid", references: "invoices", onDelete: "RESTRICT" },
    credit_limit_overridden: { type: "boolean", notNull: true, default: false },
    created_by: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    issued_by: { type: "uuid", references: "users", onDelete: "RESTRICT" },
    cancelled_by: { type: "uuid", references: "users", onDelete: "RESTRICT" },
    cancel_reason: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    issued_at: { type: "timestamptz" },
    cancelled_at: { type: "timestamptz" },
  });

  pgm.addConstraint("invoices", "invoices_tenant_client_uuid_unique", { unique: ["tenant_id", "client_uuid"] });
  pgm.addConstraint("invoices", "invoices_amounts_check", {
    check:
      "subtotal_minor >= 0 AND tax_minor >= 0 AND total_minor = subtotal_minor + tax_minor" +
      " AND amount_paid_minor >= 0 AND amount_paid_minor <= total_minor",
  });
  pgm.addConstraint("invoices", "invoices_credit_note_link_check", {
    check: "(kind = 'CREDIT_NOTE') = (credited_invoice_id IS NOT NULL)",
  });
  pgm.addConstraint("invoices", "invoices_number_when_issued_check", {
    check: "(status = 'DRAFT') = (number IS NULL)",
  });
  pgm.addConstraint("invoices", "invoices_ledger_kind_check", {
    check: "kind = 'PROFORMA' OR status = 'DRAFT' OR receivable_account_id IS NOT NULL",
  });
  pgm.createIndex("invoices", ["tenant_id", "number"], {
    name: "invoices_tenant_number_unique",
    unique: true,
    where: "number IS NOT NULL",
  });
  // A pro-forma converts into at most one invoice.
  pgm.createIndex("invoices", ["proforma_id"], {
    name: "invoices_proforma_unique",
    unique: true,
    where: "proforma_id IS NOT NULL",
  });
  pgm.createIndex("invoices", ["tenant_id", "created_at", "id"]);
  pgm.createIndex("invoices", ["tenant_id", "customer_id"]);
  pgm.createIndex("invoices", ["credited_invoice_id"], { where: "credited_invoice_id IS NOT NULL" });
  enableRls(pgm, "invoices");

  pgm.createTable("invoice_lines", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    tenant_id: { type: "uuid", notNull: true, references: "tenants", onDelete: "CASCADE" },
    invoice_id: { type: "uuid", notNull: true, references: "invoices", onDelete: "CASCADE" },
    line_no: { type: "integer", notNull: true },
    description: { type: "text", notNull: true },
    quantity: { type: "numeric(14,3)", notNull: true, check: "quantity > 0" },
    unit_price_minor: { type: "bigint", notNull: true, check: "unit_price_minor >= 0" },
    income_account_id: { type: "uuid", notNull: true, references: "accounts", onDelete: "RESTRICT" },
    tax_rate_bps: { type: "integer", notNull: true, default: 0, check: "tax_rate_bps BETWEEN 0 AND 10000" },
    tax_account_id: { type: "uuid", references: "accounts", onDelete: "RESTRICT" },
    net_minor: { type: "bigint", notNull: true },
    tax_minor: { type: "bigint", notNull: true },
    total_minor: { type: "bigint", notNull: true },
  });
  pgm.addConstraint("invoice_lines", "invoice_lines_invoice_line_no_unique", { unique: ["invoice_id", "line_no"] });
  pgm.addConstraint("invoice_lines", "invoice_lines_amounts_check", {
    check: "net_minor >= 0 AND tax_minor >= 0 AND total_minor = net_minor + tax_minor",
  });
  pgm.addConstraint("invoice_lines", "invoice_lines_tax_account_check", {
    check: "tax_rate_bps = 0 OR tax_account_id IS NOT NULL",
  });
  enableRls(pgm, "invoice_lines");

  pgm.createTable("invoice_allocations", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    tenant_id: { type: "uuid", notNull: true, references: "tenants", onDelete: "CASCADE" },
    client_uuid: { type: "uuid", notNull: true },
    invoice_id: { type: "uuid", notNull: true, references: "invoices", onDelete: "RESTRICT" },
    method: { type: "text", notNull: true, check: "method IN ('CASH', 'BANK', 'MPESA', 'OTHER', 'CREDIT_NOTE')" },
    amount_minor: { type: "bigint", notNull: true, check: "amount_minor >= 0" },
    unapplied_minor: { type: "bigint", notNull: true, default: 0, check: "unapplied_minor >= 0" },
    date: { type: "date", notNull: true },
    received_account_id: { type: "uuid", references: "accounts", onDelete: "RESTRICT" },
    reference: { type: "text" },
    journal_id: { type: "uuid", notNull: true, references: "journals", onDelete: "RESTRICT" },
    payment_id: { type: "uuid", references: "payments", onDelete: "RESTRICT" },
    credit_note_id: { type: "uuid", references: "invoices", onDelete: "RESTRICT" },
    created_by: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("invoice_allocations", "invoice_allocations_tenant_client_uuid_unique", {
    unique: ["tenant_id", "client_uuid"],
  });
  pgm.addConstraint("invoice_allocations", "invoice_allocations_nonzero_check", {
    check: "amount_minor + unapplied_minor > 0",
  });
  pgm.addConstraint("invoice_allocations", "invoice_allocations_credit_note_check", {
    check: "(method = 'CREDIT_NOTE') = (credit_note_id IS NOT NULL)",
  });
  pgm.createIndex("invoice_allocations", ["payment_id"], {
    name: "invoice_allocations_payment_unique",
    unique: true,
    where: "payment_id IS NOT NULL",
  });
  pgm.createIndex("invoice_allocations", ["credit_note_id"], {
    name: "invoice_allocations_credit_note_unique",
    unique: true,
    where: "credit_note_id IS NOT NULL",
  });
  pgm.createIndex("invoice_allocations", ["invoice_id"]);
  enableRls(pgm, "invoice_allocations");

  pgm.createTable("invoice_number_sequences", {
    tenant_id: { type: "uuid", notNull: true, references: "tenants", onDelete: "CASCADE" },
    kind: { type: "text", notNull: true, check: "kind IN ('INVOICE', 'CREDIT_NOTE', 'PROFORMA')" },
    last_value: { type: "integer", notNull: true, default: 0 },
  });
  pgm.addConstraint("invoice_number_sequences", "invoice_number_sequences_pkey", {
    primaryKey: ["tenant_id", "kind"],
  });
  enableRls(pgm, "invoice_number_sequences");

  // Section 6.1: payments carry invoice_id. An M-Pesa collection for an
  // invoice is applied to it when it posts (FR-PAY-04).
  pgm.addColumns("payments", {
    invoice_id: { type: "uuid", references: "invoices", onDelete: "RESTRICT" },
  });
  pgm.createIndex("payments", ["invoice_id"], { where: "invoice_id IS NOT NULL" });
};

exports.down = (pgm) => {
  pgm.dropColumns("payments", ["invoice_id"]);
  pgm.dropTable("invoice_number_sequences");
  pgm.dropTable("invoice_allocations");
  pgm.dropTable("invoice_lines");
  pgm.dropTable("invoices");
};
