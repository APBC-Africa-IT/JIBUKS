/**
 * Add 'BILL' to journals.source -- the Write Bill guided endpoint
 * (packages/server/src/modules/bills) posts through the same journal
 * pipeline as everything else, but tags its output distinctly, mirroring
 * 'SALE' (see 1789023703139_add-sale-source-to-journals.js) on the supplier
 * side: the classic Purchases Day Book of manual bookkeeping.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.dropConstraint("journals", "journals_source_check");
  pgm.addConstraint("journals", "journals_source_check", {
    check: "source IN ('MANUAL', 'CASHBOOK', 'PAYMENT', 'SALE', 'BILL', 'IMPORT', 'COMMUNITY', 'OPENING', 'REVERSAL')",
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint("journals", "journals_source_check");
  pgm.addConstraint("journals", "journals_source_check", {
    check: "source IN ('MANUAL', 'CASHBOOK', 'PAYMENT', 'SALE', 'IMPORT', 'COMMUNITY', 'OPENING', 'REVERSAL')",
  });
};
