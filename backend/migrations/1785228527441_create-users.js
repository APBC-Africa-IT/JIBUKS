/**
 * Create users, and retroactively add the foreign keys that earlier
 * migrations left untyped (created_by / approved_by / closed_by) because
 * users did not exist yet.
 *
 * SRS: Section 6.1 (users entity), FR-RBAC-01 (role-based access, added
 * later with roles/permissions tables), Section 2.1 (Super Admin is the
 * platform operator, not a tenant member -- hence tenant_id is nullable).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("users", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    // Nullable: a Super Admin (APBC Africa operator) belongs to no tenant.
    // Under RLS, a NULL tenant_id never matches any tenant context, so
    // Super Admin rows are correctly invisible from every tenant session.
    tenant_id: {
      type: "uuid",
      references: "tenants",
      onDelete: "CASCADE",
    },
    // The OIDC 'sub' claim from the identity provider (constraint C-03: no
    // custom authentication). Globally unique -- an IdP subject identifies
    // exactly one person across the whole platform.
    external_idp_subject: { type: "text", notNull: true },
    name: { type: "text", notNull: true },
    email: { type: "text" },
    phone: { type: "text" },
    status: {
      type: "text",
      notNull: true,
      default: "ACTIVE",
      check: "status IN ('ACTIVE', 'SUSPENDED')",
    },
    mfa_enabled: { type: "boolean", notNull: true, default: false },
    is_super_admin: { type: "boolean", notNull: true, default: false },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.addConstraint("users", "users_external_idp_subject_unique", {
    unique: ["external_idp_subject"],
  });

  // A tenant user must actually have a tenant; a Super Admin must not.
  pgm.addConstraint("users", "users_tenant_or_super_admin", {
    check: "(is_super_admin = true AND tenant_id IS NULL) OR (is_super_admin = false AND tenant_id IS NOT NULL)",
  });

  pgm.sql("ALTER TABLE users ENABLE ROW LEVEL SECURITY");
  pgm.sql("ALTER TABLE users FORCE ROW LEVEL SECURITY");
  pgm.sql(`
    CREATE POLICY tenant_isolation ON users
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  `);

  pgm.createIndex("users", ["tenant_id"]);

  // ---------------------------------------------------------------------
  // Retroactive foreign keys onto columns created before users existed.
  // ---------------------------------------------------------------------

  pgm.addConstraint("periods", "periods_closed_by_fkey", {
    foreignKeys: { columns: "closed_by", references: "users", onDelete: "RESTRICT" },
  });

  pgm.addConstraint("journals", "journals_created_by_fkey", {
    foreignKeys: { columns: "created_by", references: "users", onDelete: "RESTRICT" },
  });

  pgm.addConstraint("journals", "journals_approved_by_fkey", {
    foreignKeys: { columns: "approved_by", references: "users", onDelete: "RESTRICT" },
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint("journals", "journals_approved_by_fkey");
  pgm.dropConstraint("journals", "journals_created_by_fkey");
  pgm.dropConstraint("periods", "periods_closed_by_fkey");
  pgm.dropTable("users");
};