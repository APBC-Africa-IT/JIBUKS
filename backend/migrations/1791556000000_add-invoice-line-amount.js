/**
 * invoice_lines.amount_minor -- a line entered as a total rather than a
 * unit price (the Bill screen's Amount column). When set it is the line's
 * amount and quantity x unit_price_minor is not used, so a total that
 * doesn't divide evenly by the quantity (3 for 1,000.00) stays exact;
 * unit_price_minor then holds amount / quantity rounded, for display.
 * NULL: the amount is quantity x unit price, as before.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns("invoice_lines", {
    amount_minor: { type: "bigint", check: "amount_minor >= 0" },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns("invoice_lines", ["amount_minor"]);
};
