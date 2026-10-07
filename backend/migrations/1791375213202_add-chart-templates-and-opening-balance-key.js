/**
 * Chart-of-accounts templates (FR-COA-02, FR-TEN-01) and opening balances
 * (FR-ACC-04).
 *
 * - tenants.chart_template: which template onboarding seeded. GENERAL is the
 *   original starter set (the default while clients don't choose); the other
 *   four are SRS Appendix A. NULL for tenants onboarded before this existed.
 * - accounts.system_key 'OPENING_BALANCE': the Opening Balance Equity
 *   account that absorbs the difference in the opening journal. Seeded at
 *   3900 by every template; created on first use for older tenants.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns("tenants", {
    chart_template: {
      type: "text",
      check: "chart_template IN ('GENERAL', 'SME_TRADING', 'NGO', 'CORPORATE', 'MICRO_TRADER')",
    },
  });

  pgm.dropConstraint("accounts", "accounts_system_key_check");
  pgm.addConstraint("accounts", "accounts_system_key_check", {
    check: "system_key IN ('MPESA', 'OPENING_BALANCE')",
  });
};

exports.down = (pgm) => {
  pgm.sql("UPDATE accounts SET system_key = NULL WHERE system_key = 'OPENING_BALANCE'");
  pgm.dropConstraint("accounts", "accounts_system_key_check");
  pgm.addConstraint("accounts", "accounts_system_key_check", { check: "system_key IN ('MPESA')" });
  pgm.dropColumns("tenants", ["chart_template"]);
};
