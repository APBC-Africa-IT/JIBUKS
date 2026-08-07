/**
 * Create invites.
 *
 * Solves the real onboarding gap: POST /users needs a new teammate's Auth0
 * `sub`, but nobody knows their own `sub` before they've logged in once.
 * An invite decouples "who was invited" (an email address) from "who they
 * turn out to be in Auth0" (resolved only when they accept).
 *
 * token_hash stores SHA-256(token), never the raw token -- same principle
 * as never storing a password in plaintext. The raw token only ever exists
 * in the invite email itself and in the accept request.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("invites", {
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
    email: { type: "text", notNull: true },
    name: { type: "text" },
    token_hash: { type: "text", notNull: true },
    status: {
      type: "text",
      notNull: true,
      default: "PENDING",
      check: "status IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED')",
    },
    invited_by: {
      type: "uuid",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    accepted_by: {
      type: "uuid",
      references: "users",
      onDelete: "RESTRICT",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    expires_at: { type: "timestamptz", notNull: true },
    accepted_at: { type: "timestamptz" },
  });

  pgm.addConstraint("invites", "invites_token_hash_unique", {
    unique: ["token_hash"],
  });

  pgm.sql("ALTER TABLE invites ENABLE ROW LEVEL SECURITY");
  pgm.sql("ALTER TABLE invites FORCE ROW LEVEL SECURITY");
  pgm.sql(`
    CREATE POLICY tenant_isolation ON invites
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  `);

  pgm.createIndex("invites", ["tenant_id", "status"]);

  // Same cross-tenant lookup problem as findUserByExternalIdpSubject: an
  // invitee looking up/accepting an invite by token has no tenant context
  // yet. jibuks_auth_resolver already exists exactly for this class of
  // lookup -- extend its grant to cover invites too, rather than inventing
  // a second bypass role.
  pgm.sql("GRANT SELECT (id, tenant_id, email, name, token_hash, status, expires_at) ON invites TO jibuks_auth_resolver");
  pgm.sql("GRANT UPDATE (status, accepted_by, accepted_at) ON invites TO jibuks_auth_resolver");
};

exports.down = (pgm) => {
  pgm.dropTable("invites");
};