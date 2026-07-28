/**
 * Create journals and journal_lines.
 *
 * SRS: FR-ACC-01 (double entry), FR-ACC-02 (posted journals immutable --
 * correction only by reversal), FR-ACC-05 (tenant_id mandatory, branch_id
 * optional), DR-01 (tenant_id + RLS everywhere), DR-02 (branch_id nullable
 * from Phase 1), DR-04 (debit sum = credit sum, enforced by the database,
 * not application logic alone), DR-05 (client-generated UUID accepted as
 * identity, unique per tenant), C-04 (append-only ledger).
 *
 * Design note: a POSTED journal is never updated again, for any reason --
 * not even to record that it was later reversed. "Was this reversed" is
 * answered by checking whether another journal exists with
 * reversal_of_journal_id pointing at it. This is deliberately stricter than
 * storing a reversed_by_journal_id column on the original, which would
 * require an UPDATE to populate and would be a (small) crack in immutability.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ---------------------------------------------------------------------
  // journals
  // ---------------------------------------------------------------------

  pgm.createTable("journals", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    tenant_id: {
      type: "uuid",
      notNull: true,
      references: "tenants",
      onDelete: "CASCADE",
    },
    // DR-02: nullable from Phase 1. No FK yet -- the branches table doesn't
    // exist until Phase 4; this column exists now precisely so that adding
    // it later needs no destructive migration.
    branch_id: { type: "uuid" },
    // DR-05: the client assigns this at creation; the server accepts it
    // as-is. Unique per tenant (not globally), see constraint below.
    client_uuid: { type: "uuid", notNull: true },
    period_id: {
      type: "uuid",
      notNull: true,
      references: "periods",
      onDelete: "RESTRICT",
    },
    date: { type: "date", notNull: true },
    currency: { type: "text", notNull: true },
    description: { type: "text", notNull: true },
    reference: { type: "text" },
    source: {
      type: "text",
      notNull: true,
      check: "source IN ('MANUAL', 'CASHBOOK', 'PAYMENT', 'IMPORT', 'COMMUNITY', 'OPENING', 'REVERSAL')",
    },
    status: {
      type: "text",
      notNull: true,
      default: "DRAFT",
      check: "status IN ('DRAFT', 'PENDING_APPROVAL', 'POSTED')",
    },
    // Points from a reversal to what it reverses. Never populated on the
    // original -- only ever set once, at creation, on the reversing journal.
    reversal_of_journal_id: {
      type: "uuid",
      references: "journals",
      onDelete: "RESTRICT",
    },
    created_by: { type: "uuid", notNull: true },
    approved_by: { type: "uuid" },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.addConstraint("journals", "journals_tenant_client_uuid_unique", {
    unique: ["tenant_id", "client_uuid"],
  });

  pgm.sql("ALTER TABLE journals ENABLE ROW LEVEL SECURITY");
  pgm.sql("ALTER TABLE journals FORCE ROW LEVEL SECURITY");
  pgm.sql(`
    CREATE POLICY tenant_isolation ON journals
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  `);

  pgm.createIndex("journals", ["tenant_id", "date"]);
  pgm.createIndex("journals", ["tenant_id", "status"]);
  pgm.createIndex("journals", ["reversal_of_journal_id"]);

  // FR-ACC-02: once POSTED, a journal row may never be updated or deleted
  // again, by any role. The transition INTO 'POSTED' is fine (that's how a
  // journal gets posted in the first place) -- what's blocked is anything
  // happening to a row whose OLD status was already 'POSTED'.
  pgm.createFunction(
    "prevent_posted_journal_mutation",
    [],
    { returns: "trigger", language: "plpgsql" },
    `
    BEGIN
      IF OLD.status = 'POSTED' THEN
        RAISE EXCEPTION 'Journal % is posted and immutable; correct it with a reversing journal (FR-ACC-02)', OLD.id;
      END IF;
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END;
    `,
  );

  pgm.createTrigger("journals", "journals_prevent_posted_mutation", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    function: "prevent_posted_journal_mutation",
    level: "ROW",
  });

  // ---------------------------------------------------------------------
  // journal_lines
  // ---------------------------------------------------------------------

  pgm.createTable("journal_lines", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    // Denormalised from the parent journal so RLS can apply directly to
    // this table too (DR-01 requires tenant_id + RLS on every tenant-scoped
    // table, not just the ones a person queries directly).
    tenant_id: { type: "uuid", notNull: true },
    journal_id: {
      type: "uuid",
      notNull: true,
      references: "journals",
      onDelete: "CASCADE",
    },
    account_id: {
      type: "uuid",
      notNull: true,
      references: "accounts",
      onDelete: "RESTRICT",
    },
    debit_minor: { type: "bigint", notNull: true, default: 0 },
    credit_minor: { type: "bigint", notNull: true, default: 0 },
    narrative: { type: "text" },
    project_id: { type: "uuid" },
    department: { type: "text" },
  });

  pgm.addConstraint("journal_lines", "journal_lines_amounts_non_negative", {
    check: "debit_minor >= 0 AND credit_minor >= 0",
  });
  pgm.addConstraint("journal_lines", "journal_lines_not_both_sides", {
    check: "NOT (debit_minor > 0 AND credit_minor > 0)",
  });
  pgm.addConstraint("journal_lines", "journal_lines_one_side_required", {
    check: "debit_minor > 0 OR credit_minor > 0",
  });

  pgm.sql("ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY");
  pgm.sql("ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY");
  pgm.sql(`
    CREATE POLICY tenant_isolation ON journal_lines
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  `);

  pgm.createIndex("journal_lines", ["journal_id"]);
  pgm.createIndex("journal_lines", ["tenant_id", "account_id"]);

  // A line's tenant_id must match both its parent journal's tenant and its
  // account's tenant -- the same cross-tenant leakage this trigger guards
  // against is exactly what the accounts.parent_account_id trigger guarded
  // against in the previous migration.
  pgm.createFunction(
    "check_journal_line_tenant_consistency",
    [],
    { returns: "trigger", language: "plpgsql" },
    `
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM journals WHERE id = NEW.journal_id AND tenant_id = NEW.tenant_id
      ) THEN
        RAISE EXCEPTION 'journal_lines.tenant_id must match its journal''s tenant';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id
      ) THEN
        RAISE EXCEPTION 'journal_lines.tenant_id must match its account''s tenant';
      END IF;
      RETURN NEW;
    END;
    `,
  );

  pgm.createTrigger("journal_lines", "journal_lines_tenant_consistency", {
    when: "BEFORE",
    operation: ["INSERT", "UPDATE"],
    function: "check_journal_line_tenant_consistency",
    level: "ROW",
  });

  // FR-ACC-02: lines belonging to a POSTED journal can never be changed or
  // removed either -- otherwise immutability on the journal row would be
  // meaningless while its lines stayed editable.
  pgm.createFunction(
    "prevent_posted_journal_line_mutation",
    [],
    { returns: "trigger", language: "plpgsql" },
    `
    DECLARE
      parent_status text;
    BEGIN
      SELECT status INTO parent_status FROM journals WHERE id = COALESCE(NEW.journal_id, OLD.journal_id);
      IF parent_status = 'POSTED' THEN
        RAISE EXCEPTION 'Journal lines of a posted journal are immutable (FR-ACC-02)';
      END IF;
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END;
    `,
  );

  pgm.createTrigger("journal_lines", "journal_lines_prevent_posted_mutation", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    function: "prevent_posted_journal_line_mutation",
    level: "ROW",
  });

  // DR-04: the sum of debit_minor MUST equal the sum of credit_minor for
  // every journal, enforced by the database -- not application logic alone.
  //
  // This cannot be a plain CHECK constraint (Postgres CHECK constraints see
  // only the row being written, never other rows). It has to be a
  // *constraint trigger*, deferred to the end of the transaction, so that
  // inserting five lines for one journal is checked once, after all five
  // are in, rather than failing after the first line goes in alone.
  pgm.createFunction(
    "check_journal_balance",
    [],
    { returns: "trigger", language: "plpgsql" },
    `
    DECLARE
      target_journal_id uuid;
      total_debit bigint;
      total_credit bigint;
    BEGIN
      target_journal_id := COALESCE(NEW.journal_id, OLD.journal_id);

      SELECT COALESCE(SUM(debit_minor), 0), COALESCE(SUM(credit_minor), 0)
      INTO total_debit, total_credit
      FROM journal_lines
      WHERE journal_id = target_journal_id;

      IF total_debit <> total_credit THEN
        RAISE EXCEPTION 'Journal % does not balance: total debits % <> total credits %',
          target_journal_id, total_debit, total_credit;
      END IF;

      RETURN NULL;
    END;
    `,
  );

  pgm.sql(`
    CREATE CONSTRAINT TRIGGER journal_lines_balance_check
    AFTER INSERT OR UPDATE OR DELETE ON journal_lines
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION check_journal_balance();
  `);
};

exports.down = (pgm) => {
  pgm.dropTable("journal_lines");
  pgm.dropTable("journals");
  pgm.dropFunction("check_journal_balance", []);
  pgm.dropFunction("prevent_posted_journal_line_mutation", []);
  pgm.dropFunction("check_journal_line_tenant_consistency", []);
  pgm.dropFunction("prevent_posted_journal_mutation", []);
};