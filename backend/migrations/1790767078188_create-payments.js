/**
 * Create payments -- one row per mobile-money collection attempt
 * (FR-PAY-01..07, IF-PAY-01). Phase 1 starts with M-Pesa STK push.
 *
 * Lifecycle: PENDING -> SUCCEEDED | FAILED | CANCELLED. A row moves out of
 * PENDING exactly once (guarded by `WHERE status = 'PENDING'`), which is
 * what makes duplicate or concurrent callbacks harmless.
 *
 * A SUCCEEDED payment normally has journal_id set. If the money arrived
 * but could not be posted (no open period, amount mismatch...), journal_id
 * stays NULL and posting_error says why -- the money is real, so it must
 * never be reported as failed (FR-PAY-07); it needs a person to resolve.
 *
 * callback_token_hash: SHA-256 of the secret embedded in this payment's
 * callback URL. Daraja does not sign callbacks, so the unguessable URL
 * plus an STK status query before posting stand in for a signature
 * (Section 4.4).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("payments", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    tenant_id: {
      type: "uuid",
      notNull: true,
      references: "tenants",
      onDelete: "CASCADE",
    },
    client_uuid: { type: "uuid", notNull: true },
    provider: { type: "text", notNull: true, check: "provider IN ('MPESA')" },
    method: { type: "text", notNull: true, check: "method IN ('STK_PUSH')" },
    status: {
      type: "text",
      notNull: true,
      default: "PENDING",
      check: "status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED')",
    },
    amount_minor: { type: "bigint", notNull: true, check: "amount_minor > 0" },
    currency: { type: "text", notNull: true },
    phone: { type: "text", notNull: true },
    account_reference: { type: "text", notNull: true },
    description: { type: "text" },
    received_account_id: { type: "uuid", notNull: true, references: "accounts", onDelete: "RESTRICT" },
    credit_account_id: { type: "uuid", notNull: true, references: "accounts", onDelete: "RESTRICT" },
    customer_id: { type: "uuid", references: "customers", onDelete: "RESTRICT" },
    merchant_request_id: { type: "text" },
    checkout_request_id: { type: "text" },
    callback_token_hash: { type: "text", notNull: true },
    result_code: { type: "text" },
    result_desc: { type: "text" },
    mpesa_receipt_number: { type: "text" },
    transaction_date: { type: "date" },
    callback_payload: { type: "jsonb" },
    journal_id: { type: "uuid", references: "journals", onDelete: "RESTRICT" },
    posting_error: { type: "text" },
    initiated_by: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    completed_at: { type: "timestamptz" },
  });

  pgm.addConstraint("payments", "payments_tenant_client_uuid_unique", {
    unique: ["tenant_id", "client_uuid"],
  });
  pgm.createIndex("payments", ["checkout_request_id"], {
    name: "payments_checkout_request_id_unique",
    unique: true,
    where: "checkout_request_id IS NOT NULL",
  });
  pgm.createIndex("payments", ["tenant_id", "mpesa_receipt_number"], {
    name: "payments_tenant_receipt_unique",
    unique: true,
    where: "mpesa_receipt_number IS NOT NULL",
  });
  pgm.createIndex("payments", ["tenant_id", "created_at"]);

  pgm.sql("ALTER TABLE payments ENABLE ROW LEVEL SECURITY");
  pgm.sql("ALTER TABLE payments FORCE ROW LEVEL SECURITY");
  pgm.sql(`
    CREATE POLICY tenant_isolation ON payments
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  `);
};

exports.down = (pgm) => {
  pgm.dropTable("payments");
};
