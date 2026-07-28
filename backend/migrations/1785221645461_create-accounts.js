/**
 * Create accounts (chart of accounts).
 *
 * SRS: FR-COA-01 (hierarchical, five classifications), FR-COA-03 (posted-to
 * accounts are deactivated, never deleted -- so there is deliberately no
 * DELETE path modelled here beyond the down-migration's DROP TABLE, which is
 * a schema rollback, not a runtime operation), FR-COA-04 (tags), DR-01
 * (tenant_id + RLS mandatory).
 *
 * is_postable distinguishes a leaf account (postable) from a grouping/parent
 * account (not postable) -- this is exactly the field posting.ts's
 * AccountSnapshot.isPostable checks before allowing a journal line against it.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("accounts", {
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
    parent_account_id: {
      type: "uuid",
      references: "accounts",
      onDelete: "RESTRICT",
    },
    code: { type: "text", notNull: true },
    name: { type: "text", notNull: true },
    type: {
      type: "text",
      notNull: true,
      check: "type IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE')",
    },
    /** Null means the account accepts the tenant's base currency. */
    currency: { type: "text" },
    is_active: { type: "boolean", notNull: true, default: true },
    /** Leaf accounts are postable; grouping/parent accounts are not. */
    is_postable: { type: "boolean", notNull: true, default: true },
    tags: { type: "text[]", notNull: true, default: pgm.func("'{}'::text[]") },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  // FR-COA-03: an account code is unique within a tenant, not globally.
  pgm.addConstraint("accounts", "accounts_tenant_code_unique", {
    unique: ["tenant_id", "code"],
  });

  // A parent account must belong to the same tenant as its child.
  // Postgres has no native "same-tenant" FK check across a self-reference,
  // so this is enforced by a trigger rather than a plain constraint.
  pgm.createFunction(
    "check_account_parent_same_tenant",
    [],
    { returns: "trigger", language: "plpgsql" },
    `
    BEGIN
      IF NEW.parent_account_id IS NOT NULL THEN
        IF NOT EXISTS (
          SELECT 1 FROM accounts
          WHERE id = NEW.parent_account_id
          AND tenant_id = NEW.tenant_id
        ) THEN
          RAISE EXCEPTION 'parent_account_id must belong to the same tenant';
        END IF;
      END IF;
      RETURN NEW;
    END;
    `,
  );

  pgm.createTrigger("accounts", "accounts_parent_same_tenant", {
    when: "BEFORE",
    operation: ["INSERT", "UPDATE"],
    function: "check_account_parent_same_tenant",
    level: "ROW",
  });

  pgm.sql("ALTER TABLE accounts ENABLE ROW LEVEL SECURITY");
  pgm.sql("ALTER TABLE accounts FORCE ROW LEVEL SECURITY");

  pgm.sql(`
    CREATE POLICY tenant_isolation ON accounts
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  `);

  pgm.createIndex("accounts", ["tenant_id", "type"]);
  pgm.createIndex("accounts", ["tenant_id", "parent_account_id"]);
};

exports.down = (pgm) => {
  pgm.dropTable("accounts");
  pgm.dropFunction("check_account_parent_same_tenant", []);
};