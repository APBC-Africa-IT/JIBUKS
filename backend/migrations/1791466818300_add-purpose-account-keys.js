/**
 * More accounts.system_key purposes: RECEIVABLE, PAYABLE, VAT_INPUT,
 * VAT_OUTPUT, CASH and BANK.
 *
 * Codes can't be trusted to name an account's purpose: they clash between
 * chart templates (1200 is VAT Recoverable in GENERAL but Inventory in
 * SME_TRADING) and tenants can recode accounts (FR-COA-03). With these
 * keys the server defaults the receivable/payable/VAT accounts on invoices
 * and bills, and clients find them via GET /tenant.
 *
 * Backfill: an account is tagged only when it still is exactly what its
 * template seeded -- same code, type AND name -- and the tenant has no
 * account with that key yet. Tenants onboarded before templates existed
 * (chart_template NULL) got the GENERAL starter set. Anything renamed or
 * recoded stays untagged; the Owner tags it with PATCH /accounts/{id}.
 *
 * Also: SME_TRADING seeded 2200 VAT Payable for businesses that aren't
 * VAT-registered (a template bug). Those copies are deactivated if nothing
 * was ever posted to them.
 *
 * The list below is a frozen copy of the templates at the time of writing,
 * deliberately not imported from @jibuks/domain.
 */

exports.shorthands = undefined;

const TAGS = [
  // [template, code, type, name, key]
  ["GENERAL", "1000", "ASSET", "Cash", "CASH"],
  ["GENERAL", "1010", "ASSET", "Bank", "BANK"],
  ["GENERAL", "1100", "ASSET", "Accounts Receivable", "RECEIVABLE"],
  ["GENERAL", "1200", "ASSET", "VAT Recoverable (Input VAT)", "VAT_INPUT"],
  ["GENERAL", "2000", "LIABILITY", "Accounts Payable", "PAYABLE"],
  ["GENERAL", "2100", "LIABILITY", "VAT Payable (Output VAT)", "VAT_OUTPUT"],

  ["SME_TRADING", "1000", "ASSET", "Cash on Hand", "CASH"],
  ["SME_TRADING", "1010", "ASSET", "Bank Accounts", "BANK"],
  ["SME_TRADING", "1030", "ASSET", "Accounts Receivable", "RECEIVABLE"],
  ["SME_TRADING", "1250", "ASSET", "VAT Recoverable (Input VAT)", "VAT_INPUT"],
  ["SME_TRADING", "2000", "LIABILITY", "Accounts Payable", "PAYABLE"],

  ["NGO", "1000", "ASSET", "Cash Unrestricted", "CASH"],
  ["NGO", "1100", "ASSET", "Grants Receivable", "RECEIVABLE"],
  ["NGO", "1250", "ASSET", "VAT Recoverable (Input VAT)", "VAT_INPUT"],
  ["NGO", "2000", "LIABILITY", "Accounts Payable", "PAYABLE"],
  ["NGO", "2200", "LIABILITY", "VAT Payable", "VAT_OUTPUT"],

  ["CORPORATE", "1000", "ASSET", "Cash and Cash Equivalents", "CASH"],
  ["CORPORATE", "1100", "ASSET", "Accounts Receivable", "RECEIVABLE"],
  ["CORPORATE", "1250", "ASSET", "VAT Recoverable (Input VAT)", "VAT_INPUT"],
  ["CORPORATE", "2000", "LIABILITY", "Accounts Payable", "PAYABLE"],
  ["CORPORATE", "2510", "LIABILITY", "VAT Payable", "VAT_OUTPUT"],

  ["MICRO_TRADER", "1000", "ASSET", "Cash", "CASH"],
  ["MICRO_TRADER", "1030", "ASSET", "Money Owed to Me", "RECEIVABLE"],
  ["MICRO_TRADER", "1250", "ASSET", "VAT I Can Claim Back", "VAT_INPUT"],
  ["MICRO_TRADER", "2000", "LIABILITY", "Money I Owe", "PAYABLE"],
  ["MICRO_TRADER", "2200", "LIABILITY", "VAT I Owe", "VAT_OUTPUT"],
];

const NEW_KEYS = ["RECEIVABLE", "PAYABLE", "VAT_INPUT", "VAT_OUTPUT", "CASH", "BANK"];

exports.up = (pgm) => {
  pgm.dropConstraint("accounts", "accounts_system_key_check");
  pgm.addConstraint("accounts", "accounts_system_key_check", {
    check: `system_key IN ('MPESA', 'OPENING_BALANCE', ${NEW_KEYS.map((k) => `'${k}'`).join(", ")})`,
  });

  // SME_TRADING's 2200 VAT Payable is VAT-only: tag it for VAT-registered
  // tenants, deactivate untouched copies for everyone else.
  pgm.sql(`
    UPDATE accounts a
       SET system_key = 'VAT_OUTPUT'
      FROM tenants t
     WHERE t.id = a.tenant_id
       AND t.chart_template = 'SME_TRADING'
       AND t.vat_registered
       AND a.code = '2200' AND a.type = 'LIABILITY' AND a.name = 'VAT Payable'
       AND a.system_key IS NULL
       AND NOT EXISTS (SELECT 1 FROM accounts b WHERE b.tenant_id = a.tenant_id AND b.system_key = 'VAT_OUTPUT')
  `);
  pgm.sql(`
    UPDATE accounts a
       SET is_active = false
      FROM tenants t
     WHERE t.id = a.tenant_id
       AND t.chart_template = 'SME_TRADING'
       AND NOT t.vat_registered
       AND a.code = '2200' AND a.type = 'LIABILITY' AND a.name = 'VAT Payable'
       AND a.system_key IS NULL
       AND NOT EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.account_id = a.id)
  `);

  for (const [template, code, type, name, key] of TAGS) {
    pgm.sql(`
      UPDATE accounts a
         SET system_key = '${key}'
        FROM tenants t
       WHERE t.id = a.tenant_id
         AND COALESCE(t.chart_template, 'GENERAL') = '${template}'
         AND a.code = '${code}' AND a.type = '${type}' AND a.name = '${name.replace(/'/g, "''")}'
         AND a.system_key IS NULL
         AND NOT EXISTS (SELECT 1 FROM accounts b WHERE b.tenant_id = a.tenant_id AND b.system_key = '${key}')
    `);
  }
};

exports.down = (pgm) => {
  // The deactivated SME 2200 copies stay deactivated: they were unused, and
  // they can be reactivated with POST /accounts/{id}/reactivate.
  pgm.sql(`UPDATE accounts SET system_key = NULL WHERE system_key IN (${NEW_KEYS.map((k) => `'${k}'`).join(", ")})`);
  pgm.dropConstraint("accounts", "accounts_system_key_check");
  pgm.addConstraint("accounts", "accounts_system_key_check", {
    check: "system_key IN ('MPESA', 'OPENING_BALANCE')",
  });
};
