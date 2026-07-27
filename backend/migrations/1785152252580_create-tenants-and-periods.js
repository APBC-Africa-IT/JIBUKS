/**
 * Create tenants and periods.
 *
 * SRS: Section 6.1 (tenants, periods entities), DR-01 (every tenant-scoped
 * table carries tenant_id and has row-level security enabled), FR-TEN-01
 * (provisioning), FR-ACC-03 (period locking).
 *
 * tenants has no tenant_id of its own -- it IS the tenant registry, the root
 * every other table's RLS policy will reference. periods is the first
 * tenant-scoped table, and gets its RLS policy in this same migration so
 * that no tenant-scoped table ever exists even briefly without one.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createExtension("pgcrypto", { ifNotExists: true });

  pgm.createTable("tenants", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    name: { type: "text", notNull: true },
    type: {
      type: "text",
      notNull: true,
      check: "type IN ('BUSINESS', 'NGO', 'HOUSEHOLD')",
    },
    base_currency: { type: "text", notNull: true },
    accounting_framework: {
      type: "text",
      notNull: true,
      default: "GAAP",
      check: "accounting_framework IN ('IFRS', 'GAAP', 'IPSAS')",
    },
    plan_tier: {
      type: "text",
      notNull: true,
      default: "STARTER",
      check: "plan_tier IN ('STARTER', 'GROWTH', 'ENTERPRISE')",
    },
    status: {
      type: "text",
      notNull: true,
      default: "ACTIVE",
      check: "status IN ('ACTIVE', 'SUSPENDED')",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.createTable("periods", {
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
    start_date: { type: "date", notNull: true },
    end_date: { type: "date", notNull: true },
    status: {
      type: "text",
      notNull: true,
      default: "OPEN",
      check: "status IN ('OPEN', 'CLOSED', 'LOCKED')",
    },
    closed_by: { type: "uuid" },
    closed_at: { type: "timestamptz" },
  });

  pgm.addConstraint("periods", "periods_date_range_valid", {
    check: "end_date >= start_date",
  });

  // DR-01: row-level security is mandatory on every tenant-scoped table.
  pgm.sql("ALTER TABLE periods ENABLE ROW LEVEL SECURITY");
  pgm.sql("ALTER TABLE periods FORCE ROW LEVEL SECURITY");

  // The application sets `SET app.current_tenant_id = '<uuid>'` per connection
  // (or per transaction) after authenticating a request. This policy is the
  // database-level backstop C-05 requires -- it holds even if application
  // code has a bug and forgets to filter by tenant.
  pgm.sql(`
    CREATE POLICY tenant_isolation ON periods
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  `);

  pgm.createIndex("periods", ["tenant_id", "start_date", "end_date"]);
};

exports.down = (pgm) => {
  pgm.dropTable("periods");
  pgm.dropTable("tenants");
};