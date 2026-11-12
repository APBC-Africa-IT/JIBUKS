/**
 * Supplier details for the Suppliers hub's Add Supplier screen, and the
 * address split shared with customers.
 *
 * supplier_types is each business's list behind the Supplier Type dropdown,
 * seeded with Individual, Business, Wholesaler, Manufacturer and
 * Distributor; "+ Add type" adds to it. A supplier points at a type by id,
 * so renaming a type renames it everywhere.
 *
 * suppliers gain a code (SUP-0001, gapless per business, from
 * supplier_code_sequences; existing suppliers are numbered in the order
 * they were created), a type, city / country / postal code, VAT
 * registration and the VAT rate their bills usually carry, and how the
 * business pays them (method, bank, M-Pesa). customers gain the same
 * address fields. The existing `address` stays as the street line.
 *
 * All owned by the suppliers / customers modules (AD-02).
 */

exports.shorthands = undefined;

const DEFAULT_TYPES = ["Individual", "Business", "Wholesaler", "Manufacturer", "Distributor"];
const PAYMENT_METHODS = "('CASH', 'BANK', 'MPESA', 'CHEQUE', 'OTHER')";

function enableRls(pgm, table) {
  pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  pgm.sql(`
    CREATE POLICY tenant_isolation ON ${table}
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  `);
}

const addressColumns = {
  city: { type: "text" },
  /** ISO 3166-1 alpha-2, e.g. KE. */
  country: { type: "text", check: "country ~ '^[A-Z]{2}$'" },
  postal_code: { type: "text" },
};

exports.up = (pgm) => {
  pgm.createTable("supplier_types", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    tenant_id: { type: "uuid", notNull: true, references: "tenants", onDelete: "CASCADE" },
    name: { type: "text", notNull: true, check: "char_length(name) BETWEEN 1 AND 100" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  // "Business" and "business" are the same type.
  pgm.sql("CREATE UNIQUE INDEX supplier_types_tenant_name_unique ON supplier_types (tenant_id, lower(name))");
  enableRls(pgm, "supplier_types");

  // Runs as the migration owner, which RLS doesn't restrict.
  pgm.sql(`
    INSERT INTO supplier_types (tenant_id, name)
    SELECT t.id, d.name FROM tenants t CROSS JOIN unnest(ARRAY[${DEFAULT_TYPES.map((n) => `'${n}'`).join(", ")}]) AS d(name)
  `);

  pgm.createTable("supplier_code_sequences", {
    tenant_id: { type: "uuid", primaryKey: true, references: "tenants", onDelete: "CASCADE" },
    last_value: { type: "integer", notNull: true },
  });
  enableRls(pgm, "supplier_code_sequences");

  pgm.addColumns("suppliers", {
    code: { type: "text" },
    supplier_type_id: { type: "uuid", references: "supplier_types", onDelete: "RESTRICT" },
    ...addressColumns,
    vat_registered: { type: "boolean", notNull: true, default: false },
    /** Basis points: 1600 = 16%. null = not set. */
    default_tax_rate_bps: { type: "integer", check: "default_tax_rate_bps BETWEEN 0 AND 10000" },
    preferred_payment_method: { type: "text", check: `preferred_payment_method IN ${PAYMENT_METHODS}` },
    bank_name: { type: "text" },
    bank_account_number: { type: "text" },
    mpesa_phone: { type: "text" },
    /** The supplier's M-Pesa Paybill or Till number. */
    mpesa_paybill_till: { type: "text" },
  });
  pgm.createIndex("suppliers", ["supplier_type_id"]);

  pgm.sql(`
    UPDATE suppliers s SET code = 'SUP-' || lpad(n.seq::text, 4, '0')
      FROM (SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS seq FROM suppliers) n
     WHERE s.id = n.id
  `);
  pgm.sql(`
    INSERT INTO supplier_code_sequences (tenant_id, last_value)
    SELECT tenant_id, count(*) FROM suppliers GROUP BY tenant_id
  `);
  pgm.alterColumn("suppliers", "code", { notNull: true });
  pgm.addConstraint("suppliers", "suppliers_tenant_code_unique", { unique: ["tenant_id", "code"] });

  pgm.addColumns("customers", addressColumns);
};

exports.down = (pgm) => {
  pgm.dropColumns("customers", Object.keys(addressColumns));
  pgm.dropConstraint("suppliers", "suppliers_tenant_code_unique");
  pgm.dropColumns("suppliers", [
    "code",
    "supplier_type_id",
    ...Object.keys(addressColumns),
    "vat_registered",
    "default_tax_rate_bps",
    "preferred_payment_method",
    "bank_name",
    "bank_account_number",
    "mpesa_phone",
    "mpesa_paybill_till",
  ]);
  pgm.dropTable("supplier_code_sequences");
  pgm.dropTable("supplier_types");
};
