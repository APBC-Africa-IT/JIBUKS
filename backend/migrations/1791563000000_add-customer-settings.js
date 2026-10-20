/**
 * Customer communication preferences and business-wide customer defaults
 * (the Customers hub's Settings screen).
 *
 * customers gain how the customer wants to be contacted and whether they
 * get statements and payment reminders. The server sends nothing yet;
 * the app and the follow-up report read these.
 *
 * customer_settings holds one row per business: the payment terms, credit
 * limit and communication preferences a NEW customer starts with when the
 * request leaves them out. Changing a default never changes existing
 * customers -- each customer's own values are what count. Owned by the
 * customers module (AD-02).
 */

exports.shorthands = undefined;

const CHANNELS = "('SMS', 'WHATSAPP', 'EMAIL', 'NONE')";

exports.up = (pgm) => {
  pgm.addColumns("customers", {
    /** null = not set. */
    preferred_channel: { type: "text", check: `preferred_channel IN ${CHANNELS}` },
    send_statements: { type: "boolean", notNull: true, default: false },
    payment_reminders: { type: "boolean", notNull: true, default: false },
  });

  pgm.createTable("customer_settings", {
    tenant_id: { type: "uuid", primaryKey: true, references: "tenants", onDelete: "CASCADE" },
    payment_terms_days: { type: "integer", check: "payment_terms_days >= 0" },
    credit_limit_minor: { type: "bigint", check: "credit_limit_minor >= 0" },
    preferred_channel: { type: "text", check: `preferred_channel IN ${CHANNELS}` },
    send_statements: { type: "boolean", notNull: true, default: false },
    payment_reminders: { type: "boolean", notNull: true, default: false },
    updated_by: { type: "uuid", references: "users", onDelete: "RESTRICT" },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.sql("ALTER TABLE customer_settings ENABLE ROW LEVEL SECURITY");
  pgm.sql("ALTER TABLE customer_settings FORCE ROW LEVEL SECURITY");
  pgm.sql(`
    CREATE POLICY tenant_isolation ON customer_settings
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  `);
};

exports.down = (pgm) => {
  pgm.dropTable("customer_settings");
  pgm.dropColumns("customers", ["preferred_channel", "send_statements", "payment_reminders"]);
};
