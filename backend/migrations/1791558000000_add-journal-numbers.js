/**
 * journals.number -- JE-000001, the Ref# on the Journal Entry screen.
 *
 * Given to journals entered by hand (POST /journals), gapless per tenant,
 * in the same transaction that inserts the journal: a journal held for
 * approval gets its number at once and keeps it whether approved or
 * rejected. Journals posted by other modules (sales, bills, payments...)
 * carry their document's number in `reference` instead and stay NULL here,
 * as do manual journals entered before this migration -- posted journals
 * are immutable, so they aren't backfilled.
 *
 * The counter lives in journal_number_sequences, owned by the journals
 * module (AD-02), not in invoice_number_sequences.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns("journals", { number: { type: "text" } });
  pgm.createIndex("journals", ["tenant_id", "number"], {
    name: "journals_tenant_number_unique",
    unique: true,
    where: "number IS NOT NULL",
  });

  pgm.createTable("journal_number_sequences", {
    tenant_id: { type: "uuid", primaryKey: true, references: "tenants", onDelete: "CASCADE" },
    last_value: { type: "integer", notNull: true },
  });
  pgm.sql("ALTER TABLE journal_number_sequences ENABLE ROW LEVEL SECURITY");
  pgm.sql("ALTER TABLE journal_number_sequences FORCE ROW LEVEL SECURITY");
  pgm.sql(`
    CREATE POLICY tenant_isolation ON journal_number_sequences
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  `);
};

exports.down = (pgm) => {
  pgm.dropTable("journal_number_sequences");
  pgm.dropIndex("journals", ["tenant_id", "number"], { name: "journals_tenant_number_unique" });
  pgm.dropColumns("journals", ["number"]);
};
