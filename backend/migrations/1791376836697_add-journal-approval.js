/**
 * Journal approval (FR-JNL-01, FR-RBAC-03).
 *
 * A manual journal can be held as PENDING_APPROVAL until a second person
 * approves it (-> POSTED, approved_by/approved_at) or rejects it
 * (-> REJECTED, final). Neither status counts in any balance or report,
 * which already read POSTED journals only.
 *
 * tenants.manual_journal_approval_threshold_minor: NULL = approval off;
 * 0 = every manual journal; N = manual journals totalling N or more.
 *
 * The immutability trigger now also freezes REJECTED journals: like a
 * posted one, a rejected journal is a final record.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.dropConstraint("journals", "journals_status_check");
  pgm.addConstraint("journals", "journals_status_check", {
    check: "status IN ('DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REJECTED')",
  });
  pgm.addColumns("journals", {
    approved_at: { type: "timestamptz" },
    rejected_by: { type: "uuid" },
    rejected_at: { type: "timestamptz" },
    rejection_reason: { type: "text" },
  });
  pgm.addConstraint("journals", "journals_rejection_check", {
    check: "(status = 'REJECTED') = (rejected_by IS NOT NULL AND rejected_at IS NOT NULL AND rejection_reason IS NOT NULL)",
  });

  pgm.createFunction(
    "prevent_posted_journal_mutation",
    [],
    { returns: "trigger", language: "plpgsql", replace: true },
    `
    BEGIN
      IF OLD.status = 'POSTED' THEN
        RAISE EXCEPTION 'Journal % is posted and immutable; correct it with a reversing journal (FR-ACC-02)', OLD.id;
      END IF;
      IF OLD.status = 'REJECTED' THEN
        RAISE EXCEPTION 'Journal % was rejected and is final', OLD.id;
      END IF;
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END;
    `,
  );

  pgm.addColumns("tenants", {
    manual_journal_approval_threshold_minor: {
      type: "bigint",
      check: "manual_journal_approval_threshold_minor >= 0",
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns("tenants", ["manual_journal_approval_threshold_minor"]);
  pgm.createFunction(
    "prevent_posted_journal_mutation",
    [],
    { returns: "trigger", language: "plpgsql", replace: true },
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
  pgm.dropConstraint("journals", "journals_rejection_check");
  pgm.dropColumns("journals", ["approved_at", "rejected_by", "rejected_at", "rejection_reason"]);
  pgm.dropConstraint("journals", "journals_status_check");
  pgm.addConstraint("journals", "journals_status_check", {
    check: "status IN ('DRAFT', 'PENDING_APPROVAL', 'POSTED')",
  });
};
