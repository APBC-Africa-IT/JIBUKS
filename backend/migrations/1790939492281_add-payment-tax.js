/**
 * Add output tax (VAT) to payments, so a VAT-registered business can
 * collect a sale by M-Pesa and still split out Output VAT -- same
 * taxAccountId / taxAmountMinor convention as the guided Cash Sale.
 *
 * amount_minor stays the gross amount the customer is prompted for;
 * tax_amount_minor is the part of it credited to tax_account_id. The
 * credit account receives amount_minor - tax_amount_minor.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns("payments", {
    tax_account_id: { type: "uuid", references: "accounts", onDelete: "RESTRICT" },
    tax_amount_minor: { type: "bigint", notNull: true, default: 0 },
  });
  pgm.addConstraint("payments", "payments_tax_amount_check", {
    check: "tax_amount_minor >= 0 AND tax_amount_minor < amount_minor",
  });
  pgm.addConstraint("payments", "payments_tax_account_check", {
    check: "tax_amount_minor = 0 OR tax_account_id IS NOT NULL",
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint("payments", "payments_tax_account_check");
  pgm.dropConstraint("payments", "payments_tax_amount_check");
  pgm.dropColumns("payments", ["tax_account_id", "tax_amount_minor"]);
};
