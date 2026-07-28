/**
 * Create audit_logs.
 *
 * SRS: FR-AUD-01 (capture actor, timestamp, source IP, device, entity,
 * before/after state for every financial action), FR-AUD-02 (append-only;
 * no role may edit or delete a row, not even Super Admin), DR-06 (rows
 * chain by hash to the previous row for the same tenant, so tampering is
 * detectable), Section 8.2.
 *
 * tenant_id is nullable to allow platform-level (Super Admin / cross-tenant)
 * actions to be logged too -- these chain in their own separate sequence
 * (tenant_id IS NULL), distinct from any single tenant's chain.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("audit_logs", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    // Nullable: platform-level actions (Super Admin operating across
    // tenants) have no single tenant to scope to.
    tenant_id: {
      type: "uuid",
      references: "tenants",
      onDelete: "RESTRICT",
    },
    actor_user_id: {
      type: "uuid",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    action: {
      type: "text",
      notNull: true,
      check: "action IN ('CREATE', 'UPDATE', 'DELETE', 'APPROVE', 'EXPORT', 'READ')",
    },
    entity_type: { type: "text", notNull: true },
    entity_id: { type: "uuid", notNull: true },
    before_state: { type: "jsonb" },
    after_state: { type: "jsonb" },
    ip_address: { type: "inet" },
    device_id: { type: "text" },
    occurred_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    // Hash of the previous row in this tenant's chain (DR-06).
    hash_prev: { type: "text", notNull: true },
    // Hash of THIS row's own content, computed by trigger at insert time.
    hash_self: { type: "text" },
  });

  pgm.createIndex("audit_logs", ["tenant_id", "occurred_at"]);
  pgm.createIndex("audit_logs", ["entity_type", "entity_id"]);

  // audit_logs is queried across tenants by Super Admin / compliance
  // export, but a tenant-scoped session must only ever see its own rows.
  // NULL tenant_id rows (platform-level) are correctly invisible to every
  // tenant session under this policy, same reasoning as users.is_super_admin.
  pgm.sql("ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY");
  pgm.sql("ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY");
  pgm.sql(`
    CREATE POLICY tenant_isolation ON audit_logs
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  `);

  // FR-AUD-02: unconditional -- no UPDATE or DELETE is ever permitted on
  // this table, by any role, for any reason. Unlike journals, there is no
  // "while still a draft" exception; audit rows are immutable from creation.
  pgm.createFunction(
    "prevent_audit_log_mutation",
    [],
    { returns: "trigger", language: "plpgsql" },
    `
    BEGIN
      RAISE EXCEPTION 'audit_logs is append-only; no role may update or delete a row (FR-AUD-02)';
    END;
    `,
  );

  pgm.createTrigger("audit_logs", "audit_logs_prevent_mutation", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    function: "prevent_audit_log_mutation",
    level: "ROW",
  });

  // DR-06: compute hash_prev from the last row in this tenant's chain, and
  // hash_self from this row's own content + hash_prev. The very first row
  // for a tenant (or the platform-level chain, tenant_id IS NULL) chains to
  // a fixed genesis value instead of a real predecessor.
  pgm.createFunction(
    "compute_audit_log_hash_chain",
    [],
    { returns: "trigger", language: "plpgsql" },
    `
    DECLARE
      previous_hash text;
    BEGIN
      SELECT hash_self INTO previous_hash
      FROM audit_logs
      WHERE tenant_id IS NOT DISTINCT FROM NEW.tenant_id
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1;

      IF previous_hash IS NULL THEN
        previous_hash := 'GENESIS';
      END IF;

      NEW.hash_prev := previous_hash;

      NEW.hash_self := encode(
        digest(
          COALESCE(NEW.tenant_id::text, '') ||
          NEW.actor_user_id::text ||
          NEW.action ||
          NEW.entity_type ||
          NEW.entity_id::text ||
          COALESCE(NEW.before_state::text, '') ||
          COALESCE(NEW.after_state::text, '') ||
          NEW.occurred_at::text ||
          previous_hash,
          'sha256'
        ),
        'hex'
      );

      RETURN NEW;
    END;
    `,
  );

  pgm.createTrigger("audit_logs", "audit_logs_hash_chain", {
    when: "BEFORE",
    operation: ["INSERT"],
    function: "compute_audit_log_hash_chain",
    level: "ROW",
  });
};

exports.down = (pgm) => {
  pgm.dropTable("audit_logs");
  pgm.dropFunction("compute_audit_log_hash_chain", []);
  pgm.dropFunction("prevent_audit_log_mutation", []);
};