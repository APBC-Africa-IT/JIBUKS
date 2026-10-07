/**
 * Add tenants.tax_identifier -- the business's own tax PIN (e.g. a Kenyan
 * KRA PIN), printed on its invoices and credit notes. Optional: a business
 * not registered for tax may have none. Same format rules as a customer's
 * or supplier's tax_identifier (upper-cased, validated in @jibuks/domain).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns("tenants", {
    tax_identifier: { type: "text" },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns("tenants", ["tax_identifier"]);
};
