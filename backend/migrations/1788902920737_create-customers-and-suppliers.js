/**
 * Create customers and suppliers -- name lists, deliberately separate from
 * the chart of accounts (`accounts`). A customer/supplier needs contact
 * metadata (phone, email, address) that doesn't belong on an accounts row,
 * and mirrors how QuickBooks (the stated reference) keeps Customers/Vendors
 * as their own list rather than sub-accounts of Accounts Receivable/Payable.
 *
 * Per-party balances are computed from journal_lines.customer_id/
 * .supplier_id (added in the next migration), the same way accounts.
 * balance_minor is computed from journal_lines.account_id -- see
 * packages/server/src/modules/{customers,suppliers}/repository.ts.
 *
 * Like accounts (FR-COA-03), a customer/supplier is never deleted, only
 * deactivated, so history against it is always retrievable.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  for (const table of ["customers", "suppliers"]) {
    pgm.createTable(table, {
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
      name: { type: "text", notNull: true },
      phone: { type: "text" },
      email: { type: "text" },
      address: { type: "text" },
      tags: { type: "text[]", notNull: true, default: pgm.func("'{}'::text[]") },
      is_active: { type: "boolean", notNull: true, default: true },
      created_at: {
        type: "timestamptz",
        notNull: true,
        default: pgm.func("now()"),
      },
    });

    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    pgm.sql(`
      CREATE POLICY tenant_isolation ON ${table}
      USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    `);

    pgm.createIndex(table, ["tenant_id"]);
  }
};

exports.down = (pgm) => {
  pgm.dropTable("suppliers");
  pgm.dropTable("customers");
};
