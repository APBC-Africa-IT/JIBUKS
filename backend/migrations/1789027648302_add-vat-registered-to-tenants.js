/**
 * Whether a tenant is VAT-registered -- captured during onboarding
 * (mirrors QuickBooks-style setup) so the frontend knows whether to show
 * tax fields on the guided Credit Sale/Cash Sale/Write Bill screens, and
 * so onboarding itself knows whether to seed VAT Payable/VAT Recoverable
 * accounts into the starter chart of accounts.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns("tenants", {
    vat_registered: { type: "boolean", notNull: true, default: false },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns("tenants", ["vat_registered"]);
};
