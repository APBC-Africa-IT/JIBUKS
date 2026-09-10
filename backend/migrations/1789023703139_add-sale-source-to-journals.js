/**
 * Add 'SALE' to journals.source -- the Credit Sale guided endpoint
 * (packages/server/src/modules/creditSales) posts through the same journal
 * pipeline as everything else, but tags its output distinctly from a
 * hand-built MANUAL entry, mirroring the classic Sales Day Book / General
 * Journal split of manual bookkeeping.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.dropConstraint("journals", "journals_source_check");
  pgm.addConstraint("journals", "journals_source_check", {
    check: "source IN ('MANUAL', 'CASHBOOK', 'PAYMENT', 'SALE', 'IMPORT', 'COMMUNITY', 'OPENING', 'REVERSAL')",
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint("journals", "journals_source_check");
  pgm.addConstraint("journals", "journals_source_check", {
    check: "source IN ('MANUAL', 'CASHBOOK', 'PAYMENT', 'IMPORT', 'COMMUNITY', 'OPENING', 'REVERSAL')",
  });
};
