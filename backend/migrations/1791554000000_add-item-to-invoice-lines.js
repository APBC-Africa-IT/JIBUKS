/**
 * invoice_lines.item_id -- the catalogue item a line was picked from
 * (invoices, credit notes, pro-formas, bills, debit notes, cash sales).
 * Optional: a line can still be typed in without one. The line keeps its
 * own copy of price, account and description, so editing the item later
 * never changes a document already written.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns("invoice_lines", {
    item_id: { type: "uuid", references: "items", onDelete: "RESTRICT" },
  });
  pgm.createIndex("invoice_lines", ["item_id"], { where: "item_id IS NOT NULL" });
};

exports.down = (pgm) => {
  pgm.dropColumns("invoice_lines", ["item_id"]);
};
