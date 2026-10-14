/**
 * Create Invoice screen fields: PO number, ship-to, shipping date and the
 * invoice's own payment terms.
 *
 * payment_terms_days is the terms the due date was worked out from:
 * whatever the invoice says, else the customer's terms when it was
 * written. Stored per document so later changes to the customer don't
 * rewrite old invoices. Existing rows keep NULL (terms unknown).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns("invoices", {
    po_number: { type: "text" },
    ship_to: { type: "text" },
    shipping_date: { type: "date" },
    payment_terms_days: { type: "integer", check: "payment_terms_days BETWEEN 0 AND 365" },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns("invoices", ["po_number", "ship_to", "shipping_date", "payment_terms_days"]);
};
