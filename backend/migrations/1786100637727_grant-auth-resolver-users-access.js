/**
 * Grant jibuks_auth_resolver SELECT on every column of users.
 *
 * This grant has existed on the LOCAL dev database since the users module
 * was first built -- but it was applied by hand, directly via psql, never
 * captured as a migration. It was therefore never part of any reproducible
 * setup, and a genuinely fresh database (staging) never received it,
 * surfacing as "permission denied for table users" the first time
 * /onboarding ran against a real, freshly-migrated staging database.
 *
 * Fixed here, for real, as a proper migration -- closing the same class of
 * gap already fixed for tenants and invites.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(
    "GRANT SELECT (id, tenant_id, external_idp_subject, name, email, phone, status, mfa_enabled, is_super_admin, created_at) ON users TO jibuks_auth_resolver",
  );
};

exports.down = (pgm) => {
  pgm.sql(
    "REVOKE SELECT (id, tenant_id, external_idp_subject, name, email, phone, status, mfa_enabled, is_super_admin, created_at) ON users FROM jibuks_auth_resolver",
  );
};