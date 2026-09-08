/**
 * Let a journal line optionally attribute itself to a customer or supplier
 * -- the same kind of dimensional tag project_id/department already are
 * (see 1785225034365_create-journals-and-lines.js), except tenant
 * consistency for these two IS enforced, at the database level, because
 * per-party balances (GET /customers/{id}, GET /suppliers/{id}) depend on
 * it being correct.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns("journal_lines", {
    customer_id: {
      type: "uuid",
      references: "customers",
      onDelete: "RESTRICT",
    },
    supplier_id: {
      type: "uuid",
      references: "suppliers",
      onDelete: "RESTRICT",
    },
  });

  pgm.addConstraint("journal_lines", "journal_lines_not_both_customer_and_supplier", {
    check: "NOT (customer_id IS NOT NULL AND supplier_id IS NOT NULL)",
  });

  pgm.createIndex("journal_lines", ["tenant_id", "customer_id"]);
  pgm.createIndex("journal_lines", ["tenant_id", "supplier_id"]);

  // Replaces check_journal_line_tenant_consistency (defined in
  // 1785225034365_create-journals-and-lines.js) with the same body plus two
  // new checks -- CREATE OR REPLACE rather than dropping/recreating the
  // trigger, since the trigger itself doesn't change, only the function it
  // calls.
  pgm.createFunction(
    "check_journal_line_tenant_consistency",
    [],
    { returns: "trigger", language: "plpgsql", replace: true },
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
      IF NEW.customer_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM customers WHERE id = NEW.customer_id AND tenant_id = NEW.tenant_id
      ) THEN
        RAISE EXCEPTION 'journal_lines.tenant_id must match its customer''s tenant';
      END IF;
      IF NEW.supplier_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM suppliers WHERE id = NEW.supplier_id AND tenant_id = NEW.tenant_id
      ) THEN
        RAISE EXCEPTION 'journal_lines.tenant_id must match its supplier''s tenant';
      END IF;
      RETURN NEW;
    END;
    `,
  );
};

exports.down = (pgm) => {
  pgm.createFunction(
    "check_journal_line_tenant_consistency",
    [],
    { returns: "trigger", language: "plpgsql", replace: true },
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

  pgm.dropConstraint("journal_lines", "journal_lines_not_both_customer_and_supplier");
  pgm.dropColumns("journal_lines", ["customer_id", "supplier_id"]);
};
