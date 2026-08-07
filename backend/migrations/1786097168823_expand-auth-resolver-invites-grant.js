/**
 * Expand jibuks_auth_resolver's grant on invites to cover every column.
 *
 * Postgres column-level grants are strict: `SELECT *` requires permission
 * on ALL columns of the table, not just the ones a query happens to use.
 * The original grant (in the create_invites migration) only listed some
 * columns -- invited_by, accepted_by, created_at, accepted_at were
 * missing, so `SELECT * FROM invites` failed outright with
 * "permission denied for table invites". Found by an automated test
 * exercising the public preview/accept paths, before this ever ran in
 * production.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(
    "GRANT SELECT (id, tenant_id, email, name, token_hash, status, invited_by, accepted_by, created_at, expires_at, accepted_at) ON invites TO jibuks_auth_resolver",
  );
};

exports.down = (pgm) => {
  pgm.sql("REVOKE SELECT (invited_by, accepted_by, created_at, accepted_at) ON invites FROM jibuks_auth_resolver");
};