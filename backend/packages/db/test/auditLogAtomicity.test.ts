/**
 * Proves the atomicity guarantee recordAuditLog depends on: if the actual
 * data write in a transaction fails, its accompanying audit log entry must
 * roll back too -- never one without the other. This is what makes
 * FR-AUD-01's "every action is captured" guarantee actually hold, rather
 * than being a best-effort convention.
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, recordAuditLog, withoutTenant, withTenant } from "../src/index.js";

afterAll(async () => {
  await closePool();
});

async function makeTenantWithUser(): Promise<{ tenantId: string; userId: string }> {
  const tenantId = randomUUID();
  const userId = randomUUID();

  await withoutTenant(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, name, type, base_currency) VALUES ($1, $2, 'BUSINESS', 'KES')`,
      [tenantId, `Tenant ${tenantId}`],
    );
  });

  await withTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, external_idp_subject, name, is_super_admin) VALUES ($1, $2, $3, 'Test User', false)`,
      [userId, tenantId, `test|${userId}`],
    );
  });

  return { tenantId, userId };
}

describe("recordAuditLog atomicity", () => {
  it("commits the audit entry alongside a successful write", async () => {
    const { tenantId, userId } = await makeTenantWithUser();
    const accountId = randomUUID();

    await withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO accounts (id, tenant_id, code, name, type) VALUES ($1, $2, '1000', 'Cash', 'ASSET')`,
        [accountId, tenantId],
      );
      await recordAuditLog(client, {
        tenantId,
        action: "CREATE",
        entityType: "account",
        entityId: accountId,
        afterState: { code: "1000", name: "Cash" },
        context: { actorUserId: userId },
      });
    });

    const { accountExists, auditExists } = await withTenant(tenantId, async (client) => {
      const account = await client.query(`SELECT id FROM accounts WHERE id = $1`, [accountId]);
      const audit = await client.query(`SELECT id FROM audit_logs WHERE entity_id = $1`, [accountId]);
      return { accountExists: account.rows.length > 0, auditExists: audit.rows.length > 0 };
    });

    expect(accountExists).toBe(true);
    expect(auditExists).toBe(true);
  });

  it("rolls back the audit entry when the accompanying write fails", async () => {
    const { tenantId, userId } = await makeTenantWithUser();
    const accountId = randomUUID();

    // Seed one account with code 1000...
    await withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, '1000', 'Cash', 'ASSET')`,
        [tenantId],
      );
    });

    // ...then attempt a transaction that logs an audit entry BEFORE
    // attempting a write that will fail (duplicate code violates the
    // tenant-scoped unique constraint). If the log/write pairing is
    // truly atomic, the audit row must NOT survive the rollback.
    await expect(
      withTenant(tenantId, async (client) => {
        await recordAuditLog(client, {
          tenantId,
          action: "CREATE",
          entityType: "account",
          entityId: accountId,
          afterState: { code: "1000", name: "Duplicate Cash" },
          context: { actorUserId: userId },
        });

        // This duplicate-code insert fails, forcing a rollback of the
        // WHOLE transaction, including the audit log insert above.
        await client.query(
          `INSERT INTO accounts (id, tenant_id, code, name, type) VALUES ($1, $2, '1000', 'Duplicate Cash', 'ASSET')`,
          [accountId, tenantId],
        );
      }),
    ).rejects.toThrow(/duplicate key|unique constraint/i);

    const auditRows = await withTenant(tenantId, async (client) => {
      const result = await client.query(`SELECT id FROM audit_logs WHERE entity_id = $1`, [accountId]);
      return result.rows;
    });

    // The audit entry must NOT exist -- it was rolled back with the
    // failed write, exactly as required.
    expect(auditRows).toHaveLength(0);
  });
});