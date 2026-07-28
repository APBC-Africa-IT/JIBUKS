/**
 * Fix tenant_isolation policies to treat an empty-string tenant setting the
 * same as a genuinely missing one.
 *
 * Root cause: app.current_tenant_id is a custom GUC, not a real Postgres
 * setting. The FIRST time any query on a physical connection references it,
 * Postgres creates a placeholder for the rest of that connection's life --
 * initialised to ''  (empty string), not NULL. Our SET LOCAL correctly
 * clears the VALUE at end of transaction, but the placeholder itself
 * persists on that pooled connection. A later query on the same physical
 * connection with no tenant context set then sees current_setting(...)
 * return '' instead of NULL, and ''::uuid throws rather than failing safe.
 *
 * Fix: NULLIF(current_setting(...), '') turns '' into a real NULL before
 * the ::uuid cast, so tenant_id = NULL correctly matches nothing, exactly
 * as originally intended, regardless of connection reuse history.
 */

exports.shorthands = undefined;

const TABLES = ["periods", "accounts", "journals", "journal_lines", "users", "audit_logs"];

exports.up = (pgm) => {
  for (const table of TABLES) {
    pgm.sql(`DROP POLICY tenant_isolation ON ${table}`);
    pgm.sql(`
      CREATE POLICY tenant_isolation ON ${table}
      USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    `);
  }
};

exports.down = (pgm) => {
  for (const table of TABLES) {
    pgm.sql(`DROP POLICY tenant_isolation ON ${table}`);
    pgm.sql(`
      CREATE POLICY tenant_isolation ON ${table}
      USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    `);
  }
};