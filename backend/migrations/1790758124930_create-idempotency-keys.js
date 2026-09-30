/**
 * Create idempotency_keys -- the store behind the Idempotency-Key header.
 *
 * SRS Section 9.1 (Idempotency): "All POST, PUT and PATCH endpoints accept
 * an Idempotency-Key header ... A repeat with the same key returns the
 * original result and does not re-execute." Also C-08.
 *
 * One row per (tenant, key). A row is IN_PROGRESS while the original
 * request runs and COMPLETED once its 2xx response is stored for replay.
 * Non-2xx outcomes delete the row (the handler's transaction rolled back,
 * so nothing executed) and the client may retry under the same key.
 *
 * This is the HTTP-layer record only. The SRS's sync_operations table
 * (offline queue + sequence numbers) is a separate, later concern for the
 * /sync endpoints.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("idempotency_keys", {
    tenant_id: {
      type: "uuid",
      notNull: true,
      references: "tenants",
      onDelete: "CASCADE",
    },
    key: { type: "text", notNull: true },
    // sha256 of method + path + canonical body -- detects a key being
    // reused for a different request.
    request_hash: { type: "text", notNull: true },
    status: { type: "text", notNull: true },
    response_status: { type: "integer" },
    response_body: { type: "jsonb" },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    completed_at: { type: "timestamptz" },
  });

  pgm.addConstraint("idempotency_keys", "idempotency_keys_pkey", {
    primaryKey: ["tenant_id", "key"],
  });
  pgm.addConstraint("idempotency_keys", "idempotency_keys_status_check", {
    check: "status IN ('IN_PROGRESS', 'COMPLETED')",
  });
  pgm.addConstraint("idempotency_keys", "idempotency_keys_key_length_check", {
    check: "char_length(key) BETWEEN 1 AND 255",
  });

  pgm.sql("ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY");
  pgm.sql("ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY");
  pgm.sql(`
    CREATE POLICY tenant_isolation ON idempotency_keys
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  `);
};

exports.down = (pgm) => {
  pgm.dropTable("idempotency_keys");
};
