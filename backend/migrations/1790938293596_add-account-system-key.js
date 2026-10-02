/**
 * Add accounts.system_key -- marks the account the server itself relies on
 * for a purpose, independent of its code or name.
 *
 * Account codes are tenant-chosen (FR-COA-03), so "code 1020" can't be
 * trusted to mean M-Pesa: a business onboarded before 1020 became a
 * starter account may use that code for something else. system_key
 * 'MPESA' names the account M-Pesa collections are received into. At
 * most one account per tenant carries each key.
 *
 * Backfill: only a tenant's 1020 that is clearly the starter M-Pesa
 * account (ASSET, named M-Pesa) is tagged. Anyone else gets one created on
 * their first M-Pesa collection (payments module).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns("accounts", {
    system_key: { type: "text" },
  });
  pgm.addConstraint("accounts", "accounts_system_key_check", {
    check: "system_key IN ('MPESA')",
  });
  pgm.createIndex("accounts", ["tenant_id", "system_key"], {
    name: "accounts_tenant_system_key_unique",
    unique: true,
    where: "system_key IS NOT NULL",
  });

  pgm.sql(`
    UPDATE accounts
       SET system_key = 'MPESA'
     WHERE code = '1020'
       AND type = 'ASSET'
       AND lower(replace(name, '-', '')) = 'mpesa'
  `);
};

exports.down = (pgm) => {
  pgm.dropIndex("accounts", ["tenant_id", "system_key"], { name: "accounts_tenant_system_key_unique" });
  pgm.dropConstraint("accounts", "accounts_system_key_check");
  pgm.dropColumns("accounts", ["system_key"]);
};
