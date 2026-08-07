/**
 * Grant jibuks_auth_resolver read access to tenants.name.
 *
 * The invites preview flow (GET /invites/{token}, shown to someone with
 * no tenant context yet) needs to display which business invited them --
 * this requires reading tenants.name via the SAME auth-resolver role used
 * for every other cross-tenant identity lookup. This grant was missed
 * when the invites feature was built; found before it ever ran in
 * production, via review rather than a live failure.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql("GRANT SELECT (id, name) ON tenants TO jibuks_auth_resolver");
};

exports.down = (pgm) => {
  pgm.sql("REVOKE SELECT (id, name) ON tenants FROM jibuks_auth_resolver");
};