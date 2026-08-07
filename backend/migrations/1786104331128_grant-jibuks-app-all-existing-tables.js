/**
 * Grant jibuks_app access to every existing table, and fix the default-
 * privileges rule going forward.
 *
 * Root cause: ALTER DEFAULT PRIVILEGES is tied to WHO creates a table, not
 * database-wide. init-roles.sql.template's rule was set up by the
 * postgres superuser, but real tables are created by jibuks_migrator
 * during migrations -- a different role -- so the rule never actually
 * applied. This worked locally by accident: dev migrations happened to run
 * as the same role (macbook) that set up the rule. Production, using the
 * correct separate migrator role from the start, was never covered.
 *
 * This migration runs AS jibuks_migrator (the role that actually owns
 * these tables), so it can grant on them directly, and sets up the
 * default-privileges rule correctly this time -- scoped to the role that
 * actually creates tables, not whichever role happened to run initdb.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO jibuks_app");

  // CURRENT_USER, not a hardcoded role name -- locally migrations run as
  // "macbook", in production as "jibuks_migrator". Using CURRENT_USER
  // means this migration is correct in both places automatically, scoped
  // to whichever role is actually creating tables when it runs.
  pgm.sql("ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jibuks_app");
};

exports.down = (pgm) => {
  pgm.sql("ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM jibuks_app");
};