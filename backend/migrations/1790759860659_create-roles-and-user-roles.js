/**
 * Create roles and user_roles -- the RBAC model (SRS Section 6.1,
 * FR-RBAC-01/02, FR-MIC-08).
 *
 * Built-in roles (OWNER, ACCOUNTANT, CASHIER, VIEWER, AGENT) are defined in
 * code (@jibuks/domain permissions.ts), not stored here, so their
 * permission sets can evolve without a data migration. `roles` holds only
 * each tenant's CUSTOM roles, composed from the same fixed permission
 * catalogue.
 *
 * A user_roles row assigns exactly one of: a built-in role (system_role)
 * or a custom role (role_id). branch_id is nullable now and unused until
 * branch-scoped permissions arrive in Phase 4 (FR-RBAC-04), so that change
 * needs no migration.
 *
 * Also adds invites.role (the role an invitee receives on accepting) and
 * backfills every existing tenant user as OWNER -- before this migration
 * every user could do everything, so OWNER preserves their access.
 */

exports.shorthands = undefined;

const SYSTEM_ROLES = "('OWNER', 'ACCOUNTANT', 'CASHIER', 'VIEWER', 'AGENT')";

function enableTenantRls(pgm, table) {
  pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  pgm.sql(`
    CREATE POLICY tenant_isolation ON ${table}
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  `);
}

exports.up = (pgm) => {
  pgm.createTable("roles", {
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
    description: { type: "text" },
    // Validated against the code-side catalogue on write; stored as plain
    // text so the catalogue can grow without touching this table.
    permissions: { type: "text[]", notNull: true, default: pgm.func("'{}'::text[]") },
    // Like accounts (FR-COA-03), roles are deactivated, never deleted, so
    // audit history that references them stays resolvable.
    is_active: { type: "boolean", notNull: true, default: true },
    created_by: {
      type: "uuid",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
  pgm.createIndex("roles", ["tenant_id", pgm.func("lower(name)")], {
    name: "roles_tenant_name_unique",
    unique: true,
  });
  enableTenantRls(pgm, "roles");

  pgm.createTable("user_roles", {
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
    user_id: {
      type: "uuid",
      notNull: true,
      references: "users",
      onDelete: "CASCADE",
    },
    system_role: { type: "text" },
    role_id: {
      type: "uuid",
      references: "roles",
      onDelete: "RESTRICT",
    },
    branch_id: { type: "uuid" },
    assigned_by: {
      type: "uuid",
      references: "users",
      onDelete: "RESTRICT",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
  pgm.addConstraint("user_roles", "user_roles_exactly_one_role", {
    check: `(system_role IS NOT NULL AND role_id IS NULL AND system_role IN ${SYSTEM_ROLES})
         OR (system_role IS NULL AND role_id IS NOT NULL)`,
  });
  pgm.createIndex("user_roles", ["user_id", "system_role"], {
    name: "user_roles_user_system_role_unique",
    unique: true,
    where: "system_role IS NOT NULL",
  });
  pgm.createIndex("user_roles", ["user_id", "role_id"], {
    name: "user_roles_user_role_unique",
    unique: true,
    where: "role_id IS NOT NULL",
  });
  pgm.createIndex("user_roles", ["tenant_id"]);
  enableTenantRls(pgm, "user_roles");

  // A built-in key or a custom role's id, as text -- validated on write.
  pgm.addColumns("invites", {
    role: { type: "text", notNull: true, default: "VIEWER" },
  });
  // Accepting an invite reads it through the auth-resolver pool (the
  // invitee has no tenant context yet) -- see create-invites migration.
  pgm.sql("GRANT SELECT (role) ON invites TO jibuks_auth_resolver");

  // Backfill across ALL tenants. In production the migrator is the
  // (non-superuser) table owner, which FORCE ROW LEVEL SECURITY would
  // otherwise restrict to zero rows here. Lifting FORCE just for this
  // statement lets the owner bypass RLS; it's restored before the
  // migration's transaction commits, so nothing else ever sees it lifted.
  pgm.sql("ALTER TABLE users NO FORCE ROW LEVEL SECURITY");
  pgm.sql("ALTER TABLE user_roles NO FORCE ROW LEVEL SECURITY");
  pgm.sql(`
    INSERT INTO user_roles (tenant_id, user_id, system_role)
    SELECT tenant_id, id, 'OWNER' FROM users WHERE tenant_id IS NOT NULL
  `);
  pgm.sql("ALTER TABLE users FORCE ROW LEVEL SECURITY");
  pgm.sql("ALTER TABLE user_roles FORCE ROW LEVEL SECURITY");
};

exports.down = (pgm) => {
  pgm.sql("REVOKE SELECT (role) ON invites FROM jibuks_auth_resolver");
  pgm.dropColumns("invites", ["role"]);
  pgm.dropTable("user_roles");
  pgm.dropTable("roles");
};
