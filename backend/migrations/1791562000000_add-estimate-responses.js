/**
 * Estimate responses -- the Estimates screen's statuses.
 *
 * Estimates are pro-formas (kind PROFORMA). Their status on screen is
 * derived on read: DRAFT, PENDING (issued, no answer), ACCEPTED, DECLINED,
 * EXPIRED (past due_date -- "valid until" -- with no answer), CONVERTED
 * (an invoice was made from it) or CANCELLED. Only the customer's answer
 * is stored, here: who recorded it, when, and an optional note.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns("invoices", {
    estimate_response: { type: "text" },
    estimate_responded_at: { type: "timestamptz" },
    estimate_responded_by: { type: "uuid", references: "users", onDelete: "RESTRICT" },
    estimate_response_note: { type: "text" },
  });
  pgm.addConstraint("invoices", "invoices_estimate_response_check", {
    check:
      "(estimate_response IS NULL AND estimate_responded_at IS NULL AND estimate_responded_by IS NULL AND estimate_response_note IS NULL)" +
      " OR (kind = 'PROFORMA' AND estimate_response IN ('ACCEPTED', 'DECLINED')" +
      " AND estimate_responded_at IS NOT NULL AND estimate_responded_by IS NOT NULL)",
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint("invoices", "invoices_estimate_response_check");
  pgm.dropColumns("invoices", ["estimate_response", "estimate_responded_at", "estimate_responded_by", "estimate_response_note"]);
};
