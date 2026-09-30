/**
 * Add tax identifier, payment terms, default currency and (customers only)
 * credit limit to customers and suppliers.
 *
 * FR-AP-01: vendor records include "tax identifier (for example KRA PIN),
 * payment terms and default currency". FR-AR-01: customer records include
 * "credit limit and default currency". Section 6.1 lists tax_identifier on
 * customers too, and payment terms go on both so step-7 invoices can
 * derive a due date for either side.
 *
 * currency follows accounts.currency: NULL means "the tenant's base
 * currency". credit_limit_minor is in the customer's currency (C-07:
 * integer minor units); NULL means no limit set.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  for (const table of ["customers", "suppliers"]) {
    pgm.addColumns(table, {
      tax_identifier: { type: "text" },
      payment_terms_days: { type: "integer" },
      currency: { type: "text" },
    });
    pgm.addConstraint(table, `${table}_payment_terms_days_check`, {
      check: "payment_terms_days BETWEEN 0 AND 365",
    });
  }

  pgm.addColumns("customers", {
    credit_limit_minor: { type: "bigint" },
  });
  pgm.addConstraint("customers", "customers_credit_limit_minor_check", {
    check: "credit_limit_minor >= 0",
  });
};

exports.down = (pgm) => {
  pgm.dropColumns("customers", ["credit_limit_minor"]);
  for (const table of ["customers", "suppliers"]) {
    pgm.dropColumns(table, ["tax_identifier", "payment_terms_days", "currency"]);
  }
};
