/**
 * Create items -- the product/service catalogue behind the Item dropdowns
 * on invoices, bills and cash sales.
 *
 * Like customers and accounts, an item is never deleted, only deactivated,
 * so history that names it stays readable. A sub-item points at its parent
 * (parent_item_id); names are unique among siblings, ignoring case.
 *
 * track_stock is stored now for INVENTORY items; quantity on hand and cost
 * of goods sold are a later step and need their own tables.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("items", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    tenant_id: { type: "uuid", notNull: true, references: "tenants", onDelete: "CASCADE" },
    type: { type: "text", notNull: true, check: "type IN ('SERVICE', 'NON_INVENTORY', 'INVENTORY')" },
    name: { type: "text", notNull: true },
    parent_item_id: { type: "uuid", references: "items", onDelete: "RESTRICT" },
    unit_of_measure: { type: "text" },
    rate_minor: { type: "bigint", check: "rate_minor >= 0" },
    income_account_id: { type: "uuid", references: "accounts", onDelete: "RESTRICT" },
    expense_account_id: { type: "uuid", references: "accounts", onDelete: "RESTRICT" },
    inventory_account_id: { type: "uuid", references: "accounts", onDelete: "RESTRICT" },
    track_stock: { type: "boolean", notNull: true, default: false },
    description: { type: "text" },
    is_active: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("items", "items_inventory_only_check", {
    check: "type = 'INVENTORY' OR (track_stock = false AND inventory_account_id IS NULL)",
  });
  pgm.addConstraint("items", "items_not_own_parent_check", { check: "parent_item_id IS NULL OR parent_item_id <> id" });
  pgm.sql(`
    CREATE UNIQUE INDEX items_tenant_parent_name_unique
      ON items (tenant_id, COALESCE(parent_item_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  `);
  pgm.createIndex("items", ["parent_item_id"], { where: "parent_item_id IS NOT NULL" });

  pgm.sql("ALTER TABLE items ENABLE ROW LEVEL SECURITY");
  pgm.sql("ALTER TABLE items FORCE ROW LEVEL SECURITY");
  pgm.sql(`
    CREATE POLICY tenant_isolation ON items
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  `);
};

exports.down = (pgm) => {
  pgm.dropTable("items");
};
